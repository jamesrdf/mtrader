// replicate.js
/*
 *  Copyright (c) 2018-2019 James Leigh, Some Rights Reserved
 *
 *  Redistribution and use in source and binary forms, with or without
 *  modification, are permitted provided that the following conditions are met:
 *
 *  1. Redistributions of source code must retain the above copyright notice,
 *  this list of conditions and the following disclaimer.
 *
 *  2. Redistributions in binary form must reproduce the above copyright
 *  notice, this list of conditions and the following disclaimer in the
 *  documentation and/or other materials provided with the distribution.
 *
 *  3. Neither the name of the copyright holder nor the names of its
 *  contributors may be used to endorse or promote products derived from this
 *  software without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 *  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 *  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 *  ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 *  LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 *  CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 *  SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 *  INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 *  CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
'use strict';

const _ = require('underscore');
const fs = require('graceful-fs');
const url = require('url');
const http = require('http');
const https = require('https');
const path = require('path');
const Big = require('big.js');
const moment = require('moment-timezone');
const merge = require('./merge.js');
const interrupt = require('./interrupt.js');
const config = require('./config.js');
const logger = require('./logger.js');
const expect = require('chai').expect;
const version = require('../package.json').version;

/**
 * Aligns the working orders on a broker with the order rows from the collect result.
 * Assumes all orders, that are not STP orders, will be filled and are
 * conditional upon previous orders with the same contract.
 * Assumes no orders are conditional upon a STP order.
 */
module.exports = function(broker, collect) {
    let promiseHelp;
    return _.extend(function(options) {
        if (!promiseHelp) promiseHelp = help(broker, collect);
        if (options.help) return promiseHelp;
        else return promiseHelp.then(help => {
            const opts = _.defaults({
                now: moment(options.now).valueOf()
            }, _.pick(options, _.keys(_.first(help).options)));
            return replicate(broker, collect, opts);
        });
    }, {
        close() {
            return Promise.resolve();
        }
    });
};

/**
 * Array of one Object with description of module, including supported options
 */
function help(broker, collect) {
    return Promise.all([collect({help: true}), broker({help: true})]).then(_.flatten)
      .then(list => list.reduce((help, delegate) => {
        return _.extend(help, {options: _.extend({}, delegate.options, help.options)});
    }, {
        name: 'replicate',
        usage: 'replicate(options)',
        description: "Changes workers orders to align with orders in result",
        properties: ['action', 'quant', 'type', 'limit', 'stop', 'tif', 'symbol', 'market', 'currency', 'secType', 'multiplier', 'order_ref', 'attach_ref'],
        options: {
            markets: {
                usage: '[<market>]',
                description: "Array of markets of positions that should be closed if no desired position exists"
            },
            currency: {
                usage: '<currency>',
                description: "The currency used in parameters, such as 'initial_deposit'"
            },
            margin_acct: {
                usage: '<true>',
                description: "Indicates all currencies should be considered in account value and initial_deposit"
            },
            quant_threshold: {
                usage: '<integer>',
                description: "Minimum quantity of shares/contracts that must change to generate a change order"
            },
            quant_threshold_percent: {
                usage: '<decimal>',
                description: "Minimum quantity, relative to current position, that must change to generate a change order"
            }
        }
    })).then(help => [help]);
}

/**
 * Aligns the working orders on the given broker with the order rows from the collect result
 */
async function replicate(broker, collect, options) {
    const check = interrupt();
    const desired = await getDesiredPositions(broker, collect, options);
    const working = await getWorkingPositions(broker, options);
    const portfolio = _.uniq(Object.keys(desired).concat(getPortfolio(options.markets, options))).sort();
    logger.trace("replicate portfolio", ...portfolio);
    _.forEach(working, (w, contract) => {
        if (!desired[contract] && +w.position && !~portfolio.indexOf(contract)) {
            logger.warn("Unknown position", w.position, w.symbol, w.market);
        }
    });
    const orders = portfolio.reduce((orders, contract) => {
        const [symbol, market] = contract.match(/^(.+)\W(\w+)$/);
        const d = desired[contract] || { symbol, market, position:0, asof: 0 };
        const w = working[contract] || { symbol, market, position:0, asof: 0 };
        const quant_threshold = getQuantThreshold(w, options);
        const update = updateWorking(d, w, _.defaults({quant_threshold}, options));
        if (!update.length) return orders;
        const cancelled = update.filter(ord => ord.action == 'cancel');
        if (update.length == cancelled.length) return orders.concat(cancelled);
        const parent_order = update.filter(ord => ord.action != 'cancel').reduceRight((pending, prior) => {
            if (isStopOrder(prior)) // STP orders are assumed to be OCO orders
                return {
                    action: 'OCA',
                    ..._.pick(prior, 'asof', 'symbol', 'market', 'currency', 'secType', 'multiplier'),
                    attached:[prior, pending]
                };
            else if (pending.action == 'OCA')
                return {...prior, attached: pending.attached};
            else // assumed to be conditional upon prior orders of the same contract
                return {...prior, attached: [pending]};
        });
        logger.debug("replicate", "desired", contract, JSON.stringify(desired[contract]));
        return orders.concat(cancelled, parent_order);
    }, []);
    await check();
    logger.trace("replicate submit orders", ...orders);
    const submitted = await Promise.all(orders.map(async(order) => broker({...order, now: options.now}), []));
    const log = s => {
        logger.info(s.action, s.quant, s.symbol, s.market, s.type, s.tif, s.order_ref, s.status);
        return s;
    }
    return [].concat(...submitted).map(log);
}

/**
 * Collects the options results and converts the orders into positions
 */
async function getDesiredPositions(broker, collect, options) {
    const balances = await broker({action: 'balances', asof: options.begin, now: options.now});
    const local_balances = balances.filter(options.currency ?
        bal => bal.currency == options.currency : bal => +bal.rate == 1
    );
    const local_balance_net = local_balances.reduce((net, bal) => net.add(bal.net), Big(0));
    const local_balance_rate = local_balances.length ? local_balances[0].rate : 1;
    const initial_deposit = !options.margin_acct || !balances.length ? Big(local_balance_net) :
        balances.map(bal => Big(bal.net).times(bal.rate).div(local_balance_rate)).reduce((a,b) => a.add(b));
    const parameters = { initial_deposit: initial_deposit.toString(), strategy_raw: initial_deposit.toString() };
    logger.debug("replicate parameters", parameters);
    const orders = await collect(merge(options, {parameters}));
    return orders.reduce((positions, row) => {
        const traded_at = row.traded_at || row.asof || (row.parkUntilSecs || row.posted_time_unix ?
                moment(row.parkUntilSecs || row.posted_time_unix, 'X').format() : null)
        const order = c2signal({
            action: row.action.charAt(0) == 'B' ? 'BUY' : 'SELL',
            quant: row.quant,
            symbol: row.symbol,
            market: row.market,
            currency: row.currency,
            secType: row.secType || (row.typeofsymbol == 'future' ? 'FUT' : 'STK'),
            multiplier: row.multiplier,
            type: row.type || (+row.limit ? 'LMT' : +row.stop ? 'STP' : 'MKT'),
            limit: row.limit,
            stop: row.stop,
            stoploss: row.stoploss,
            tif: row.tif || row.duration || 'DAY',
            status: traded_at && moment(traded_at).isAfter(options.now) ? 'pending' : null,
            traded_at: traded_at
        });
        const symbol = order.symbol;
        const market = order.market;
        const contract = `${order.symbol}.${order.market}`;
        const prior = positions[contract] ||
            Object.assign(_.pick(order, 'symbol', 'market', 'currency', 'secType', 'multiplier'), {position: 0, asof: 0});
        return _.defaults({
            [contract]: advance(prior, order, options)
        }, positions);
    }, {});
}

/**
 * Retrieves the open positions and working orders from broker
 */
async function getWorkingPositions(broker, options) {
    const [broker_positions, broker_orders] = await Promise.all([
        broker({action: 'positions', now: options.now}),
        broker({action: 'orders', now: options.now})
    ]);
    const all_positions = _.groupBy(broker_positions, pos => `${pos.symbol}.${pos.market}`);
    const positions = _.mapObject(all_positions, positions => positions.reduce((net, pos) => {
        return {...net, position: +net.position + +pos.position};
    }));
    const working = _.groupBy(broker_orders.filter(ord => {
        return ord.status == 'pending' || ord.status == 'working';
    }), ord => `${ord.symbol}.${ord.market}`);
    return _.reduce(working, (positions, orders, contract) => sortOrders(orders)
      .reduce((positions, order) => {
        const symbol = order.symbol;
        const market = order.market;
        const prior = positions[contract] ||
            Object.assign(_.pick(order, 'symbol', 'market', 'currency', 'secType', 'multiplier'), {position: 0, asof: 0});
        return _.defaults({
            [contract]: advance(prior, order, options)
        }, positions);
    }, positions), positions);
}

function getPortfolio(markets, options, portfolio = []) {
    return [].concat(options.portfolio||[]).reduce((portfolio,item) => {
        if (item && typeof item == 'object') return getPortfolio(markets, item, portfolio);
        else if (typeof item == 'string' && !markets) return portfolio.concat(item);
        const [, symbol, market] = (item||'').toString().match(/^(.+)\W(\w+)$/) || [];
        if (!market) throw Error(`Unknown contract syntax ${item} in portfolio ${portfolio}`);
        else if (~markets.indexOf(market)) return portfolio.concat(item);
        else return portfolio;
    }, portfolio);
}

/**
 * Converts quant_threshold_percent into quant_threshold relative to open position size
 */
function getQuantThreshold(working, options) {
    if (!options.quant_threshold_percent) return options.quant_threshold || 0;
    if (working.prior) return getQuantThreshold(working.prior, options);
    const opened = working.position;
    const threshold = Math.floor(opened * options.quant_threshold_percent /100);
    if (!threshold) return options.quant_threshold || 0;
    else if (!options.quant_threshold) return threshold;
    else return Math.min(threshold, options.quant_threshold);
}

/**
 * Array of orders to update the working positions to the desired positions
 */
function updateWorking(desired, working, options) {
    const ds = desired.order;
    const ws = working.order;
    const d_opened = Math.abs(desired.position);
    const w_opened = Math.abs(working.position);
    const within = Math.abs(d_opened - w_opened) <= (options.quant_threshold || 0);
    const same_side = desired.position/Math.abs(+desired.position||1) != -1*working.position/Math.abs(+working.position||1);
    const ds_projected = ds && ds.status == 'pending';
    if (_.has(ds, 'traded_at') && !working.prior && working.traded_at && moment(working.traded_at).isAfter(ds.traded_at)) {
        if (d_opened != w_opened || !same_side) {
            // working position has since been closed (stoploss) since the last desired signal was produced
            logger.warn(`Working ${desired.symbol} position has since been closed`);
        }
        return [];
    } else if (!d_opened && !w_opened && !working.prior && !desired.prior) {
        // no open position
        return [];
    } else if (within && !working.prior && same_side && desired.prior && isStopOrder(ds)) {
        // advance working state
        const adj = updateWorking(desired.prior, working, options);
        return appendSignal(adj, _.defaults({
            // adjust stoploss quant if first signal
            quant: _.isEmpty(adj) && d_opened == ds.quant ? w_opened : ds.quant
        }, ds), options);
    } else if (within && !working.prior && same_side) {
        // positions are (nearly) the same
        return [];
    } else if (d_opened == w_opened && working.prior && !desired.prior && same_side) {
        // cancel working signals
        return cancelSignal(desired, working, options);
    } else if (desired.prior && !working.prior) {
        // advance working state
        const adj = updateWorking(desired.prior, working, options);
        return appendSignal(adj, _.defaults({
            // adjust quant if first signal
            quant: _.isEmpty(adj.filter(a=>!isStopOrder(a))) && Math.abs(d_opened - w_opened) || ds.quant
        }, ds), options);
    } else if (working.prior && !desired.prior) {
        // cancel working signal
        expect(ws).to.have.property('order_ref');
        return cancelSignal(desired, working, options);
    } else if (desired.prior && working.prior) {
        if (sameSignal(ds, ws, options.quant_threshold)) {
            // don't change this signal
            return updateWorking(desired.prior, working.prior, options);
        } else if (isStopOrder(ds) && isStopOrder(ws) && sameSignal(ds, ws, options.quant_threshold)) {
            // signals are both stoploss orders and within quant_threshold
            return updateWorking(desired.prior, working.prior, options);
        } else if (isStopOrder(ds) && isStopOrder(ws) && ds_projected && ds.action == ws.action) {
            // signals are both stoploss orders, but the desired stoploss has not come into effect yet
            return updateWorking(desired.prior, working.prior, options);
        } else if (isStopOrder(ds) && ds_projected) {
            // desired signal is stoploss order, but has not come into effect yet
            return updateWorking(desired.prior, working, options);
        } else if (similarSignals(ds, ws)) {
            // replace order
            expect(ws).to.have.property('order_ref');
            const adj = updateWorking(desired.prior, working.prior, options);
            if (adj.some(ord => ord.action == 'cancel' && ord.order_ref == ws.attach_ref))
                return appendSignal(adj, ds, options);
            else return appendSignal(adj, _.defaults({ // parent order is not cancelled
                order_ref: ws.order_ref
            }, ds), options);
        } else if (d_opened != w_opened && same_side) {
            return cancelSignal(desired, working, options);
        } else {
            // cancel and submit
            const upon = cancelSignal(desired.prior, working, options);
            const working_state = _.isEmpty(upon) ? working : working.prior;
            const cond = {...ds, attach_ref: _.isEmpty(upon) && !isStopOrder(ws) ? ws.order_ref : ds.attach_ref};
            return appendSignal(upon, cond, options);
        }
    } else {
        return [c2signal({
            action: desired.position > working.position ? 'BUY' : 'SELL',
            quant: Math.abs(desired.position - working.position),
            symbol: desired.symbol,
            market: desired.market,
            currency: desired.currency,
            secType: desired.secType,
            multiplier: desired.multiplier,
            type: (ds||desired).limit ? 'LMT' : (ds||desired).type || 'MKT',
            limit: (ds||desired).limit,
            stop: (ds||desired).stop,
            offset: (ds||desired).offset,
            tif: (ds||desired).tif || 'DAY'
        })];
    }
}

/**
 * Checks if the two orders appear to be the same
 */
function sameSignal(a, b, threshold) {
    if (!a || !b) return false;
    const attrs = ['action', 'type', 'limit', 'stop', 'offset', 'tif'];
    return isMatch(b, _.pick(a, attrs)) && Math.abs(a.quant - b.quant) <= (threshold || 0);
}

function isMatch(object, attrs) {
    var keys = _.keys(attrs), length = keys.length;
    if (object == null) return !length;
    var obj = Object(object);
    for (var i = 0; i < length; i++) {
        var key = keys[i];
        if (!(key in obj) || attrs[key] != obj[key] && +attrs[key] != +obj[key]) return false;
    }
    return true;
}

/**
 * Cancels the latest working order iff it would not be re-submitted
 */
function cancelSignal(desired, working, options) {
    const ws = working.order;
    expect(ws).to.have.property('order_ref');
    const adj = updateWorking(desired, working.prior, options);
    // check if cancelling order is the same of submitting order
    const same = _.find(adj, a => sameSignal(a, ws));
    const similar = _.find(adj, a => !a.order_ref && similarSignals(a, ws));
    if (same)
        return _.without(adj, same);
    else if (similar)
        return adj.map(a => a == similar ? _.extend({order_ref: ws.order_ref}, a) : a);
    else if (isStopOrder(ws) && adj.some(a => moment(a.traded_at).isAfter(options.now)))
        return adj; // don't cancel stoploss order until replacements orders come into effect
    else
        return [{...ws, action: 'cancel'}].concat(adj);
}

/**
 * Adds ds to the upon array
 */
function appendSignal(upon, ds, options) {
    return upon.concat(ds);
}

/**
 * If two orders have the same order type, but may different on quant
 */
function similarSignals(a, b) {
    if (!a || !b) return false;
    return a.action == b.action && a.type == b.type;
}

/**
 * If the open and close orders have the same quant, but opposite actions
 */
function isOpenAndClose(open, close, options) {
    return open.quant == close.quant &&
        (open.traded_at == close.traded_at ||
            moment(open.traded_at).isBefore(options.now) &&
            moment(close.traded_at).isBefore(options.now)) &&
        (open.action == 'BUY' && close.action == 'SELL' ||
            open.action == 'SELL' && close.action == 'BUY');
}

/**
 * Position after applying the given signal
 */
function advance(pos, order, options) {
    const position = updateStoploss(pos, order, options);
    if (!order.limit && !order.offset) return position;
    // record limit/offset for use with adjustements
    else return _.extend({}, position, {limit: order.limit, offset: order.offset});
}

function updateStoploss(pos, order, options) {
    if (order.quant === 0 && order.traded_at && moment(order.traded_at).isAfter(options.now)) {
        return pos; // don't update order adjustement limits if in the future
    } else if (order.stoploss) {
        const base = !+order.quant && pos.prior && ~pos.order.type.indexOf('STP') ? pos.prior : pos;
        const prior = advance(base, _.omit(order, 'stoploss'), options);
        const stp_order = _.omit(_.extend(_.pick(c2signal(order), 'symbol', 'market', 'currency', 'secType', 'multipler', 'traded_at', 'status'), {
            action: prior.position > 0 ? 'SELL' : 'BUY',
            quant: Math.abs(prior.position),
            tif: 'GTC',
            type: 'STP',
            stop: order.stoploss,
        }), _.isUndefined);
        return _.defaults({order: stp_order, prior}, prior);
    } else if (isStopOrder(order)) {
        expect(order).to.have.property('stop').that.is.ok;
        const prior = pos.prior && ~pos.order.type.indexOf('STP') ? pos.prior : pos;
        return _.defaults({order: c2signal(order), prior}, pos);
    } else {
        return updatePosition(pos, order, options);
    }
}

/**
 * Position after applying the given order
 */
function updatePosition(pos, order, options) {
    if (+order.quant > 0) {
        return changePosition(pos, order, options);
    } else {
        return updateParkUntilSecs(pos, order, options);
    }
}

/**
 * Position after applying the given order traded_at date and limit
 */
function updateParkUntilSecs(pos, order, options) {
    if (order.traded_at && pos.order) {
        expect(order).to.have.property('action').that.is.oneOf(['BUY', 'SELL']);
        const updated = _.defaults({order: _.defaults(_.pick(order, 'traded_at', 'status'), pos.order)}, pos);
        return updateLimit(updated, order, options);
    } else {
        return updateLimit(pos, order, options);
    }
}

/**
 * Position after applying the given order limit
 */
function updateLimit(pos, order, options) {
    if ((order.limit || order.offset) && pos.order) {
        return _.defaults({order: _.defaults(_.pick(order, 'limit', 'stop', 'offset'), pos.order)}, pos);
    } else {
        return pos;
    }
}

/**
 * Position after applying the given order to change the position size
 */
function changePosition(pos, order, options) {
    expect(order).has.property('quant').that.is.above(0);
    const prior = order.status == 'working' || order.status == 'pending' ||
        !order.traded_at || moment(order.traded_at).isAfter(options.now) ? {prior: pos} : {};
    return _.extend(prior, changePositionSize(pos, order, options));
}

/**
 * Position after changing the position size
 */
function changePositionSize(pos, order, options) {
    expect(order).has.property('quant').that.is.above(0);
    if (order.action == 'BUY') {
        return {
            asof: order.traded_at,
            symbol: order.symbol,
            market: order.market,
            currency: order.currency,
            secType: order.secType,
            multiplier: order.multiplier,
            position: +pos.position + +order.quant,
            order: c2signal(order)
        };
    } else if (order.action == 'SELL') {
        return {
            asof: order.traded_at,
            symbol: order.symbol,
            market: order.market,
            currency: order.currency,
            secType: order.secType,
            multiplier: order.multiplier,
            position: +pos.position - +order.quant,
            order: c2signal(order)
        };
    } else {
        throw Error("Unknown order action: " + JSON.stringify(order));
    }
}

/**
 * Returns the order (identity function)
 */
function c2signal(order) {
    return _.mapObject(_.omit(order, v => v == null), v => v.toString());
}

/**
 * Sorts the orders such that orders with order_ref appears before orders with the same attach_ref 
 */
function sortOrders(orders) {
    if (orders.length < 2) return orders;
    const order_refs = _.indexBy(orders.filter(ord => ord.order_ref), 'order_ref');
    const target_orders = orders.filter(ord => !order_refs[ord.attach_ref] && !isStopOrder(ord));
    const stop_orders = orders.filter(ord => !order_refs[ord.attach_ref] && isStopOrder(ord));
    const working = [].concat(stop_orders, target_orders);
    if (!working.length) throw Error(`Could not sort array ${JSON.stringify(orders)}`);
    return working.concat(sortOrders(_.difference(orders, working)));
}

function isStopOrder(order) {
    expect(order).to.have.property('type').that.is.ok;
    return ~order.type.indexOf('STP');
}
