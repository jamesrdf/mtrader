// broker-ib.js
/*
 *  Copyright (c) 2019 James Leigh, Some Rights Reserved
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

const util = require('util');
const path = require('path');
const _ = require('underscore');
const moment = require('moment-timezone');
const Big = require('big.js');
const merge = require('./merge.js');
const logger = require('./logger.js');
const version = require('./version.js').toString();
const config = require('./config.js');
const IB = require('./ib-gateway.js');
const Fetch = require('./fetch.js');
const expect = require('chai').expect;

module.exports = function(settings = {}, mock_ib_client = null) {
    if (settings.info=='help') return helpSettings();
    if (settings.info=='version') return [{version}];
    const markets = _.omit(_.mapObject(config('markets'), market => Object.assign(
        _.pick(market, v => !_.isObject(v)), (market.datasources||{}).ib
    )), v => !v);
    expect(settings).to.have.property('account').that.is.ok;
    if (settings.local_accounts) expect(settings.account).to.be.oneOf(settings.local_accounts);
    const ib = mock_ib_client && mock_ib_client.open ? mock_ib_client : new IB(settings);
    const fetch = new Fetch(merge(config('fetch'), settings.fetch));
    const root_ref = ((Date.now() * process.pid) % 8589869056).toString(16);
    return _.extend(async function(options) {
        if (options.info=='help') return helpOptions();
        if (options.info=='version') return [{version}];
        await ib.open();
        switch(options.action) {
            case 'balances': return listBalances(markets, ib, fetch, settings, options);
            case 'positions': return listPositions(markets, ib, fetch, settings, options);
            case 'orders': return listOrders(markets, ib, settings, options);
            case 'cancel': return cancelOrder(markets, ib, settings, options);
            case 'OCA': return oneCancelsAllOrders(root_ref, markets, ib, settings, options);
            case 'BUY':
            case 'SELL': return submitOrder(root_ref, markets, ib, settings, options);
            default: expect(options).to.have.property('action').to.be.oneOf([
                'balances', 'positions', 'orders', 'cancel', 'OCA', 'BUY', 'SELL'
            ]);
        }
    }, {
        open() {
            return ib.open();
        },
        close() {
            return Promise.all([
                fetch.close(),
                ib.close()
            ]);
        }
    });
};

/**
 * Array of one Object with description of module, including supported options
 */
function helpSettings() {
    return [{
        name: 'broker',
        usage: 'broker(settings)',
        description: "Information needed to identify the broker account",
        options: {
            account: {
                usage: '<string>',
                description: "IB account and/or model"
            },
            transmit: {
                usage: 'true|false',
                description: "If the system should transmit orders automatically for execution, otherwise wait for manual transmition via TWS user interface"
            },
            local_accounts: {
                usage: '[<stirng>,...]',
                description: "An array of accounts that can be used with this broker"
            }
        }
    }];
}

/**
 * Array of one Object with description of module, including supported options
 */
function helpOptions() {
    return Promise.resolve([{
        name: 'balances',
        usage: 'broker(options)',
        description: "List a summary of current account balances",
        properties: [
            'asof', 'acctNumber', 'currency', 'rate',
            'net', 'settled', 'accrued', 'realized', 'unrealized', 'margin'
        ],
        options: {
            action: {
                usage: '<string>',
                values: [
                    'balances'
                ]
            },
            now: {
                usage: '<dateTime>',
                description: "Overrides the system clock"
            },
            asof: {
                usage: '<dateTime>',
                description: "Currency balances at a particular point in time (if available)"
            },
            begin: {
                usage: '<dateTime>',
                description: "Include historic balances since given dateTime, but before given asof"
            }
        }
    }, {
        name: 'positions',
        usage: 'broker(options)',
        description: "List a summary of recent trades and their effect on the account position",
        properties: [
            'asof', 'acctNumber', 'action', 'quant', 'position', 'traded_at', 'traded_price', 'price',
            'sales', 'purchases', 'dividend', 'commission', 'mtm', 'value',
            'symbol', 'market', 'currency', 'security_type', 'multiplier'
        ],
        options: {
            action: {
                usage: '<string>',
                values: [
                    'positions'
                ]
            },
            now: {
                usage: '<dateTime>',
                description: "Overrides the system clock"
            },
            asof: {
                usage: '<dateTime>',
                description: "Positions at a particular point in time (if available)"
            },
            begin: {
                usage: '<dateTime>',
                description: "Include historic balances since given dateTime, but before given asof"
            }
        }
    }, {
        name: 'orders',
        usage: 'broker(options)',
        description: "List a summary of open orders",
        properties: [
            'posted_at', 'asof', 'traded_at', 'action', 'quant', 'order_type', 'limit', 'stop', 'offset',
            'traded_price', 'tif', 'extended_hours', 'status',
            'order_ref', 'attach_ref', 'acctNumber', 'symbol', 'market', 'currency', 'security_type', 'multiplier'
        ],
        options: {
            action: {
                usage: '<string>',
                values: [
                    'orders'
                ]
            },
            now: {
                usage: '<dateTime>',
                description: "Overrides the system clock"
            },
            asof: {
                usage: '<dateTime>',
                description: "Open orders at a particular point in time (if available)"
            },
            begin: {
                usage: '<dateTime>',
                description: "Include historic balances since given dateTime, but before given asof"
            }
        }
    }, {
        name: 'submit',
        usage: 'broker(options)',
        description: "Transmit order for trading",
        properties: [
            'posted_at', 'asof', 'action', 'quant', 'order_type', 'limit', 'stop', 'offset',
            'tif', 'extended_hours', 'status',
            'order_ref', 'attach_ref', 'symbol', 'market', 'security_type', 'currency', 'multiplier'
        ],
        options: {
            action: {
                usage: '<string>',
                values: ['BUY', 'SELL', 'OCA', 'cancel']
            },
            quant: {
                usage: '<positive-integer>',
                description: "The number of shares or contracts to buy or sell"
            },
            order_type: {
                usage: '<order-type>',
                values: ['MKT', 'MIT', 'MOO', 'MOC', 'LMT', 'LOO', 'LOC', 'STP']
            },
            limit: {
                usage: '<limit-price>',
                descirption: "The limit price for orders of type LMT"
            },
            stop: {
                usage: '<aux-price>',
                description: "Stop limit price for STP orders"
            },
            offset: {
                usage: '<price-offset>',
                description: "Pegged and snap order offset"
            },
            tif: {
                usage: '<time-in-forced>',
                values: ['GTC', 'DAY', 'IOC']
            },
            extended_hours: {
                usage: 'true',
                values: ['true'],
                description: "If set, Allows orders to also trigger or fill outside of regular trading hours."
            },
            order_ref: {
                usage: '<string>',
                description: "The order identifier that is unique among working orders"
            },
            attach_ref: {
                usage: '<string>',
                description: "The order_ref of the parent order that must be filled before this order or a common identifier for orders in the same one-cancels-all (OCA) group."
            },
            attached: {
                usage: '[...orders]',
                description: "Submit attached parent/child orders together or OCA group of orders"
            },
            symbol: {
                usage: '<string>',
                description: "The symbol of the contract to be traded, omit for OCA and bag orders"
            },
            market: {
                usage: '<string>',
                description: "The market of the contract (might also be the name of the exchange)"
            },
            security_type: {
                values: ['STK', 'FUT', 'OPT']
            },
            currency: {
                usage: '<string>',
                values: ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY']
            },
            multiplier: {
                usage: '<number>',
                description: "The value of a single unit of change in price"
            },
            minTick: {
                usage: '<decimal>',
                description: "The minimum increment at the current price level (used by SNAP STK)"
            }
        }
    }]);
}

async function listBalances(markets, ib, fetch, settings, options) {
    const ib_tz = settings.tz || (moment.defaultZone||{}).name || moment.tz.guess();
    const accounts = await listAccounts(ib, settings.account);
    const now = moment().tz(ib_tz);
    const asof = moment(options.asof || options.now).tz(ib_tz);
    const begin = options.begin ? moment(options.begin).tz(ib_tz) :
        moment(asof).subtract(5,'days');
    const begin_format = begin.format('YYYYMMDD HH:mm:ss');
    const asof_format = asof.format('YYYYMMDD HH:mm:ss');
    const balances = await Promise.all(accounts.map(async(acctNumber) => {
        const previously = begin ? await ib.reqAccountHistory(acctNumber, begin_format) : [];
        const currently = await ib.reqAccountUpdate(acctNumber);
        const data = !previously.length || _.last(previously).time < currently.time ?
            previously.concat(currently) : previously;
        const historic = data.filter((summary,i) => i === 0 || summary.time <= asof_format);
        const latest = _.last(historic);
        const range = options.begin ? historic.filter(summary => {
            if (summary.time == latest.time) return true;
            else return begin_format < summary.time;
        }) : latest ? [latest] : [];
        return [].concat(...range.map(summary => {
            const time = summary.time ? parseTime(summary.time, ib_tz) : now;
            expect(summary).to.have.property('Currency').that.is.an('array');
            return _.uniq(summary.Currency).filter(currency => currency != 'BASE').map(currency => {
                return {
                    asof: time.isValid() ? time.format() : now.format(),
                    acctNumber, currency,
                    rate: summary.ExchangeRate[currency],
                    net: summary.NetLiquidationByCurrency[currency],
                    settled: Big(summary.CashBalance[currency])
                        .minus((summary.FuturesPNL||{})[currency]||0).toString(),
                    accrued: Big((summary.AccruedCash||{})[currency]||0)
                        .add((summary.AccruedDividend||{})[currency]||0)
                        .add((summary.FuturesPNL||{})[currency]||0).toString(),
                    realized: summary.RealizedPnL[currency],
                    unrealized: summary.UnrealizedPnL[currency],
                    margin: (summary.TotalCashValue||{})[currency] != (summary.BuyingPower||{})[currency] ?
                        (summary.MaintMarginReq||{})[currency] : null
                };
            });
        }));
    }));
    return [].concat(...balances);
}

async function listPositions(markets, ib, fetch, settings, options) {
    const ib_tz = settings.tz || (moment.defaultZone||{}).name || moment.tz.guess();
    const account = settings.account;
    const positions = account && account != 'All' ? await ib.reqPositionsMulti(account) : await ib.reqPositions();
    if (!positions) throw Error(`No IB account ${account} exists`);
    const historical = {};
    const changes = await Promise.all(Object.keys(positions).sort().map(account => {
        return listAccountPositions(markets, ib, fetch, account, positions[account], historical, ib_tz, options);
    }));
    const sorted = _.sortBy([].concat(...changes), 'asof');
    if (options.begin) return sorted;
    else return sorted.filter((p,i,a) => p.position || p.asof == _.last(a).asof);
}

async function listOrders(markets, ib, settings, options) {
    const ib_tz = settings.tz || (moment.defaultZone||{}).name || moment.tz.guess();
    const account = settings.account;
    const accounts = await listAccounts(ib, account);
    const open_orders = await ib.reqOpenOrders();
    const begin = moment(options.begin || options.asof).tz(ib_tz).format('YYYYMMDD HH:mm:ss');
    const asof = options.asof && moment(options.asof).tz(ib_tz).format('YYYYMMDD HH:mm:ss');
    const completed_orders = options.begin || options.asof ? await ib.reqCompletedOrders({
        acctCode: accounts.length == 1 ? _.first(accounts) : null,
        time: asof
    }) : [];
    const orders = open_orders.concat(completed_orders.filter(o => begin < o.asof && asof <= o.asof));
    return orders.filter(order => {
        if (asof < order.posted_time) return false;
        else if (order.secType == 'BAG' && !order.comboLegsDescrip) return false; // completed
        else if (!account || account == 'All') return true;
        else if (order.faGroup == account || order.faProfile == account) return true;
        else if (~accounts.indexOf(order.account)) return true;
        else return false;
    }).reduce(async(promise, order) => {
        const result = await promise;
        const ord = await ibToOrder(markets, ib, settings, order, options);
        const parent = order.parentId && orders.find(p => order.parentId == p.orderId);
        const bag = order.secType == 'BAG';
        const working = ~open_orders.indexOf(order);
        result.push({...ord,
            quant: working ? order.remaining : order.totalQuantity,
            attach_ref: bag ? order.orderRef || order.permId :
                parent ? parent.orderRef|| parent.permId : order.ocaGroup,
            symbol: bag ? null : asSymbol(order),
            market: bag ? null : await asMarket(markets, ib, order)
        });
        if (!bag) return result;
        else if (!order.comboLegs) throw Error(`Missing comboLegs on BAG order ${util.inspect(order)}`);
        else return order.comboLegs.reduce(async(promise, leg, i) => {
            const result = await promise;
            result.push({
                action: leg.action,
                quant: Big(order.remaining).div(ord.quant).div(leg.ratio).toString(),
                order_type: 'LEG',
                limit: ((order.orderComboLegs||[])[i]||{}).price || null,
                stop: null,
                offset: null,
                tif: null,
                extended_hours: null,
                order_ref: null,
                attach_ref: ord.order_ref,
                account: ord.account,
                symbol: asSymbol(leg),
                market: await asMarket(markets, ib, leg),
                currency: leg.currency,
                security_type: leg.secType,
                multiplier: leg.multiplier
            });
            return result;
        }, Promise.resolve(result));
    }, Promise.resolve([]));
}

async function cancelOrder(markets, ib, settings, options) {
    expect(options).to.have.property('order_ref').that.is.ok;
    const ib_order = await orderByRef(ib, options.order_ref);
    if (!ib_order) throw Error(`Unknown order_ref ${options.order_ref}`);
    const cancelled_order = await ib.cancelOrder(ib_order.orderId);
    const order = ibToOrder(markets, ib, settings, {...ib_order, ...cancelled_order}, options);
    return [order];
}

async function oneCancelsAllOrders(root_ref, markets, ib, settings, options) {
    expect(options).to.have.property('attached').that.is.an('array');
    const order_ref = orderRef(root_ref, await ib.reqId(), options);
    return await options.attached.reduce(async(promise, order, i, orders) => {
        const posted_orders = await submitOrder(root_ref, markets, ib, {
            ...settings,
            transmit: settings.transmit || false
        }, order, null, order_ref);
        return (await promise).concat(posted_orders.map(ord => ({...ord, attach_ref: order_ref})));
    }, []);
}

async function submitOrder(root_ref, markets, ib, settings, options, parentId, ocaGroup) {
    const attach_order = options.attach_ref ? await orderByRef(ib, options.attach_ref) : null;
    const oca_group = ocaGroup || (options.attach_ref && !attach_order ? options.attach_ref : null);
    const replacing_id = (await orderByRef(ib, options.order_ref)||{}).orderId;
    const reqId = replacing_id ? async(fn) => fn(replacing_id).catch(err => {
        logger.warn("Could not replace order: ", err);
        return ib.reqId(fn);
    }) : ib.reqId;
    const contract = await toContract(markets, ib, options);
    const ib_order = await orderToIbOrder(markets, ib, settings, contract, options, options);
    const posted_order = await reqId(async(order_id) => {
        const order_ref = orderRef(root_ref, order_id, options);
        const submit_order = {
            ...ib_order,
            orderId: order_id, orderRef: order_ref,
            transmit: (contract.secType == 'BAG' || _.isEmpty(options.attached)) && settings.transmit || false,
            parentId: parentId || (attach_order ? attach_order.orderId : null),
            ocaGroup: oca_group, ocaType: oca_group ? 1 : 0,
            smartComboRoutingParams: contract.secType == 'BAG' ? [{tag:'NonGuaranteed',value:'1'}] : []
        };
        return await ib.placeOrder(order_id, contract, submit_order);
    });
    const order_id = posted_order.orderId;
    const order_ref = orderRef(root_ref, order_id, options);
    const parent_order = await ibToOrder(markets, ib, settings, posted_order, options);
    const attached = flattenOCA(options.attached);
    return attached.reduce(async(promise, attach, i, attached) => {
        const child_orders = attach.order_type == 'LEG' ? [{
            ..._.omit(parent_order, 'limit', 'stop', 'offset', 'traded_price', 'order_ref'),
            ..._.pick(attach, 'symbol', 'market', 'currency', 'multiplier', 'action', 'quant', 'order_type', 'limit', 'stop', 'offset'),
            attach_ref: parent_order.order_ref
        }] : await submitOrder(root_ref, markets, ib, {
            ...settings,
            transmit: i == attached.length -1 && settings.transmit || false
        }, attach, order_id);
        return (await promise).concat(child_orders.map(ord => ({...ord, attach_ref: order_ref})));
    }, [parent_order]);
}

function flattenOCA(orders) {
    if (!orders) return [];
    else return orders.reduce((list, order) => {
        if (order.action != 'OCA') return list.concat(order);
        else return list.concat(flattenOCA(order.attached));
    }, []);
}

function orderRef(root_ref, order_id, options) {
    if (options.order_ref) return options.order_ref;
    const idx = (options.order_type||'').indexOf(' (IBALGO)');
    const label = ~idx && options.order_type.substring(0, idx) || options.order_type || options.action || '';
    return `${label.replace(/\W+/g,'')}.${root_ref}.${order_id}`;
}

async function orderByRef(ib, order_ref) {
    if (!order_ref) return null;
    const recent_ib_orders = await ib.reqRecentOrders();
    const recent_ib_order = recent_ib_orders.filter(ord => {
        return ord.orderRef == order_ref || ord.permId == order_ref || ord.orderId == order_ref;
    }).reduce((latest, order) => latest && latest.order_id >= order.order_id ? latest : order, null);
    if (recent_ib_order) return recent_ib_order;
    else if (recent_ib_orders.some(ord => ord.ocaGroup == order_ref)) return null;
    const open_ib_orders = await ib.reqOpenOrders();
    const ib_order = open_ib_orders.find(ord => {
        return ord.orderRef == order_ref || ord.permId == order_ref || ord.orderId == order_ref;
    });
    if (ib_order) return ib_order;
    else return null;
}

async function orderToIbOrder(markets, ib, settings, contract, order, options) {
    expect(order).to.have.property('action').that.is.oneOf(['BUY', 'SELL']);
    expect(order).to.have.property('quant').that.is.ok;
    expect(order).to.have.property('order_type').that.is.ok;
    expect(order).to.have.property('tif').that.is.oneOf(['DAY', 'GTC', 'IOC', 'OPG', 'FOK', 'DTC']);
    const ibalgo = order.order_type.indexOf(' (IBALGO)');
    if (~ibalgo) {
        const algoParams = order.order_type.substring(ibalgo + ' (IBALGO)'.length).split(';')
            .filter(a=>a.length).map(pair => _.object(['tag', 'value'], pair.trim().split('=', 2)));
        return {
            action: order.action,
            totalQuantity: order.quant,
            orderType: order.limit ? 'LMT' : 'MKT',
            algoStrategy: order.order_type.substring(0, ibalgo),
            algoParams,
            lmtPrice: order.limit,
            auxPrice: order.stop || order.offset,
            tif: order.tif,
            outsideRth: !!order.extended_hours,
            orderRef: order.order_ref,
            transmit: settings.transmit || false,
            ...await ibAccountOrderProperties(ib, settings)
        };
    } else if (order.order_type == 'SNAP STK') {
        return {
            action: order.action,
            totalQuantity: order.quant,
            orderType: 'LMT',
            lmtPrice: await snapStockLimit(markets, ib, contract, order),
            tif: order.tif,
            outsideRth: !!order.extended_hours,
            orderRef: order.order_ref,
            transmit: settings.transmit || false,
            ...await ibAccountOrderProperties(ib, settings)
        };
    } else {
        return {
            action: order.action,
            totalQuantity: order.quant,
            orderType: order.order_type,
            lmtPrice: order.limit,
            auxPrice: order.stop || order.offset,
            tif: order.tif,
            outsideRth: !!order.extended_hours,
            orderRef: order.order_ref,
            transmit: settings.transmit || false,
            ...await ibAccountOrderProperties(ib, settings)
        };
    }
}

async function snapStockLimit(markets, ib, contract, order) {
    if (_.isEmpty(order.attached)) {
        expect(contract.secType).to.be.oneOf(['FUT', 'OPT','FOP']);
        const detail = _.first(await ib.reqContractDetails(contract));
        const right = detail.summary.right;
        expect(right).is.oneOf(['C', 'P']);
        const minTick = Math.max(order.minTick||0, detail.minTick||0.000001);
        const exchange = (detail.validExchanges||'').split(',').find(ex => ex != 'SMART') ||
            detail.summary.exchange;
        const [bar, under_bar] = await Promise.all([
            ib.reqMktData(contract),
            ib.reqMktData({
                conId: detail.underConId,
                exchange: exchange
            })
        ]);
        if (!bar || !bar.bid || !bar.ask)
            throw Error(`Can only submit SNAP STK ${order.order_ref} orders while market is open`);
        const net_offset = order.action == 'BUY' && right == 'C' ||
            order.action == 'SELL' && right == 'P' ?
            Big(order.offset||0).times(-1) : Big(order.offset||0);
        const price = await snapStockPrice(ib, contract, bar, under_bar, net_offset);
        return +Big(price).div(minTick).round(0, order.action == 'BUY' ? 0 : 3).times(minTick);
    } else {
        order.attached.forEach(leg => {
            expect(leg).to.have.property('symbol').that.is.a('string');
            expect(leg).to.have.property('action').that.is.oneOf(['BUY', 'SELL']);
            expect(leg).to.have.property('order_type').that.eql('LEG');
            expect(leg).to.have.property('security_type').that.is.oneOf(['FUT', 'OPT','FOP']);
        });
        const [detail, contracts] = await Promise.all([
            toContract(markets, ib, _.first(order.attached)).then(contract => {
                return ib.reqContractDetails(contract).then(_.first);
            }),
            Promise.all(order.attached.map(async(leg) => {
                return toContractWithId(markets, ib, leg);
            }))
        ]);
        const detail_minTick = detail.minTick||0.000001;
        const leg_minTick = order.attached.reduce((minTick, leg) => {
            return Math.min(minTick, leg.minTick||detail_minTick);
        }, Infinity);
        const minTick = Math.max(detail_minTick, leg_minTick, order.minTick||0);
        const right = detail.summary.right;
        const exchange = (detail.validExchanges||'').split(',').find(ex => ex != 'SMART') ||
            detail.summary.exchange;
        contracts.forEach(contract => {
            expect(contract.right).is.oneOf(['C', 'P']);
            expect(contract.right).to.eql(right);
        });
        const [bars, under_bar] = await Promise.all([
            Promise.all(contracts.map(async(contract) => {
                return ib.reqMktData(contract);
            })),
            ib.reqMktData({
                conId: detail.underConId,
                symbol: detail.underSymbol,
                secType: detail.underSecType,
                exchange: exchange
            })
        ]);
        if (bars.some(bar => !bar.bid || !bar.ask))
            throw Error("Can only submit SNAP STK orders while market is active");
        const net_mid_price = netPrice(order.attached, bars.map(bar => +Big(bar.bid).add(bar.ask).div(2)));
        const net_offset = order.action == 'BUY' && right == 'C' && +net_mid_price >= 0 ||
            order.action == 'SELL' && right == 'P' && +net_mid_price >= 0 ?
            Big(order.offset||0).times(-1) : Big(order.offset||0);
        const prices = await Promise.all(order.attached.map(async(leg, i) => {
            return snapStockPrice(ib, contracts[i], bars[i], under_bar, net_offset);
        }));
        const price = netPrice(order.attached, prices);
        if (order.action == 'BUY') {
            const buy_limit = +Big(price).div(minTick).round(0, 0).times(minTick);
            if (buy_limit) return buy_limit;
        }
        const sell_limit = +Big(price).div(minTick).round(0, 3).times(minTick);
        if (sell_limit) return sell_limit;
        else return +Big(price).div(minTick).round(0, 0).times(minTick);
    }
}

async function snapStockPrice(ib, contract, bar, under_bar, net_offset) {
    if (!+net_offset) return +Big(bar.bid).add(bar.ask).div(2);
    else if (!bar.ask_option && contract.secType != 'OPT' && contract.secType != 'FOP')
        return +Big(bar.bid).add(bar.ask).div(2).add(net_offset);
    if (!bar.model_option)
        throw Error(`No model for option ${contract.localSymbol} ${util.inspect(bar)}`);
    const undPrice = bar.model_option.undPrice != Number.MAX_VALUE && bar.model_option.undPrice || null;
    const asset_price = undPrice || under_bar.last || +Big(under_bar.bid).add(under_bar.ask).div(2);
    if (!+asset_price)
        throw Error(`Can only submit SNAP STK orders while market is active ${util.inspect(under_bar)}`);
    const asset_offset = +Big(asset_price).add(net_offset);
    const iv = bar.model_option.iv || +Big(bar.ask_option.iv).add(bar.bid_option.iv).div(2);
    if (!iv || iv == Number.MAX_VALUE || iv == Number.MAX_VALUE/2)
        throw Error(`No implied volatility for option ${contract.localSymbol} ${util.inspect(bar.model_option)}`);
    const option = await ib.calculateOptionPrice(contract, iv, asset_offset);
    logger.log("calculated option price model", option.optPrice, '+', +net_offset, bar.model_option);
    return +Big(option.optPrice).minus(bar.model_option.optPrice).add(Big(bar.bid).add(bar.ask).div(2));
}

function netPrice(legs, leg_prices) {
    return +leg_prices.reduce((net, leg_price, i) => {
        const leg = legs[i];
        const buy = leg.action == 'BUY' ? 1 : -1;
        return net.add(Big(leg_price).times(leg.quant).times(buy));
    }, Big(0));
}

async function ibAccountOrderProperties(ib, settings) {
    const account = settings.account;
    const managed_accts = await ib.reqManagedAccts();
    if (~managed_accts.indexOf(account)) return {account};
    const aliases = await ib.requestAliases();
    const alias = aliases.find(a => account == a.alias);
    if (alias) return {account: alias.account};
    const groups = await ib.requestGroups();
    const group = groups.find(g => account == g.name);
    if (group) return {faGroup: group.name, faMethod: group.defaultMethod};
    const profiles = await ib.requestProfiles();
    const profile = profiles.find(p => account == p.name);
    if (profile) return {faProfile: profile.name};
    return {account: managed_accts[0], modelCode: account}; // maybe a model?
}

async function ibToOrder(markets, ib, settings, order, options) {
    const ib_tz = settings.tz || (moment.defaultZone||{}).name || moment.tz.guess();
    const status = order.status == 'ApiPending' ? 'pending' :
        order.status == 'PendingSubmit' ? 'pending' :
        order.status == 'Inactive' ? 'pending' :
        order.status == 'PendingCancel' ? 'cancelled' :
        order.status == 'PreSubmitted' ? 'working' :
        order.status == 'Submitted' ? 'working' :
        order.status == 'ApiCancelled' ? 'working' :
        order.status == 'Filled' ? 'filled' : 'cancelled';
    return {
        posted_at: order.posted_time ? parseTime(order.posted_time, ib_tz).format() : null,
        asof: order.time ? parseTime(order.time, ib_tz).format() : null,
        traded_at: order.completedTime ? parseTime(order.completedTime, ib_tz).format() : null,
        action: order.action,
        quant: order.totalQuantity,
        order_type: orderTypeFromIB(order),
        limit: order.lmtPrice == Number.MAX_VALUE ? null : order.lmtPrice,
        stop: order.auxPrice == Number.MAX_VALUE ? null : order.auxPrice,
        offset: order.auxPrice == Number.MAX_VALUE || order.orderType == 'STP' ||
            order.orderType == 'STP LMT' ? null : order.auxPrice,
        tif: order.tif,
        extended_hours: order.outsideRth,
        status: status,
        traded_price: +order.avgFillPrice ? order.avgFillPrice : null,
        order_ref: order.orderRef || order.permId || order.orderId,
        attach_ref: options.attach_ref,
        account: order.faGroup || order.faProfile || order.account,
        symbol: asSymbol(order),
        market: options.market ? options.market :
            order.secType != 'BAG' ? await asMarket(markets, ib, order) : null,
        currency: order.currency,
        security_type: order.secType,
        multiplier: order.multiplier
    };
}

function orderTypeFromIB(order) {
    if (order.orderRef && order.orderRef.indexOf('SNAPSTK') === 0) return 'SNAP STK';
    if (!order.algoStrategy) return order.orderType;
    const algoParams = (order.algoParams||[]).map(tv => `${tv.tag}=${tv.value}`).join(';');
    return (`${order.algoStrategy} (IBALGO) ${algoParams}`).trim();
}

async function listAccounts(ib, account) {
    const managed_accts = await ib.reqManagedAccts();
    if (!account || 'All' == account) return managed_accts;
    else if (~managed_accts.indexOf(account)) return [account];
    const aliases = await ib.requestAliases();
    const alias = aliases.filter(a => account == a.alias);
    if (alias.length) return alias.map(a => a.account);
    const groups = await ib.requestGroups();
    const group = groups.find(g => account == g.name);
    if (group) return group.ListOfAccts;
    const profiles = await ib.requestProfiles();
    const profile = profiles.find(p => account == p.name);
    if (profile) return profile.ListOfAllocations.map(a => a.acct);
    return [account]; // maybe a model?
}

async function listAccountPositions(markets, ib, fetch, account, positions, historical, ib_tz, options) {
    const begin_format = options.begin && moment(options.begin).format();
    const asof_format = moment(options.asof).format();
    const begin = options.begin ? moment(options.begin).tz(ib_tz) :
        moment(options.asof).tz(ib_tz).subtract(5,'days');
    const executions = await ib.reqExecutions({
        acctCode: account,
        time: begin ? begin.format('YYYYMMDD HH:mm:ss') : null
    });
    // TODO don't assume conIds in executions mean the same in positions
    const conIds = _.union(Object.keys(positions).map(i => parseInt(i)), collectConIds(executions));
    const listChanges = listContractPositions.bind(this, markets, ib, fetch);
    const changes = await Promise.all(conIds.sort().map(async(conId) => {
        const con_pos = positions[conId];
        const con_exe = executions.filter(exe => exe.conId == conId).map(exe => ({
            asof: parseTime(exe.time, ib_tz).format(),
            ...exe
        })).filter(exe => exe.asof <= asof_format);
        const contract = con_pos ? await ib.reqContract(conId) : _.first(con_exe);
        if (contract.secType == 'BAG') return [];
        const changes = await listChanges(contract, con_pos, con_exe, historical, ib_tz, options);
        if (options.begin) return changes.filter((p,i,a) => {
            return begin_format < p.asof || i == a.length-1 && p.position;
        });
        else if (!changes.length) return [];
        else return [_.last(changes)];
    }));
    return [].concat(...changes).map(trade => Object.assign({
        asof: trade.asof,
        acctNumber: account
    }, trade));
}

async function listContractPositions(markets, ib, fetch, contract, pos, executions, historical, ib_tz, options) {
    const symbol = asSymbol(contract);
    const market = await asMarket(markets, ib, contract);
    const now = moment().format();
    const earliest = moment(options.asof || options.now).subtract(5, 'days').startOf('day').format();
    const key = `${contract.conId} ${earliest}`;
    const promise = historical[key] = historical[key] ||
        loadHistoricalData(fetch, symbol, market, earliest, {...options, ...markets[market]});
    const bars = await promise;
    if (!bars.length) return [];
    const multiplier = contract.multiplier || 1;
    const ending_position = pos ? pos.position : 0;
    const newer_details = executions.filter(exe => {
        return exe.asof > _.last(bars).ending;
    });
    const latest_trade = changePosition(multiplier, _.last(bars), newer_details, _.last(bars), ending_position);
    const changes = [];
    const starting_position = bars.reduceRight((position, bar, i, bars) => {
        const details = executions.filter(exe => {
            return exe.asof <= bar.ending &&
                (i == 0 || bars[i-1].ending < exe.asof);
        });
        changes[i] = changePosition(multiplier, bars[i-1] || bar, details, bar, position);
        if (!changes[i].quant)
            return position;
        else if (changes[i].action.charAt(0) == 'B')
            return position - changes[i].quant;
        else if (changes[i].action.charAt(0) == 'S')
            return +position + +changes[i].quant;
        else
            throw Error(`Invalid trade action ${changes[i].action}`);
    }, ending_position - latest_trade.quant * (latest_trade.action.charAt(0) == 'S' ? -1 : 1));
    if (newer_details.length) {
        changes.push({...latest_trade, asof: latest_trade.traded_at});
    }
    return changes.filter(trade => trade.action)
      .map(trade => Object.assign({
        asof: trade.asof,
        sales: contract.secType == 'FUT' ? 0 : trade.sales,
        purchases: contract.secType == 'FUT' ? 0 : trade.purchases,
        symbol, market,
        currency: contract.currency,
        security_type: contract.secType,
        multiplier: contract.multiplier
    }, trade, {asof: trade.asof < now ? trade.asof : now}));
}

function changePosition(multiplier, prev_bar, details, bar, position) {
    const adj = Big(bar.close).div(+bar.adj_close || +bar.close || 1);
    const dividend = +Big(prev_bar.close).minus(Big(prev_bar.adj_close).times(adj)).toFixed(8);
    const ending_value = Big(position).times(bar.close).times(multiplier);
    const quant = details.reduce((shares, exe) => shares + +exe.shares, 0);
    const shares = details.reduce((shares, exe) => shares + +exe.shares * (exe.side == 'SLD' ? -1 : 1), 0);
    const starting_position = position - shares;
    const starting_value = Big(starting_position).times(prev_bar.close).times(multiplier);
    const net_dividend = Big(starting_position).times(dividend).times(multiplier);
    const purchase = details.filter(exe => exe.side == 'BOT')
        .reduce((net, exe) => net.add(Big(exe.price).times(exe.shares).times(multiplier)), Big(0));
    const sold = details.filter(exe => exe.side == 'SLD')
        .reduce((net, exe) => net.add(Big(exe.price).times(exe.shares).times(multiplier)), Big(0));
    const commission = details.reduce((net, exe) => net.add(exe.commission || 0), Big(0));
    const mtm = Big(ending_value).minus(starting_value)
        .add(sold).minus(purchase).add(net_dividend).minus(commission);
    const action = position == 0 && quant == 0 ? '' :
        position > 0 && shares == 0 ? 'LONG' :
        position < 0 && shares == 0 ? 'SHORT' :
        starting_position >= 0 && position >= 0 && shares > 0 ? 'BTO' :
        starting_position >= 0 && position >= 0 && shares < 0 ? 'STC' :
        starting_position <= 0 && position <= 0 && shares < 0 ? 'STO' :
        starting_position <= 0 && position <= 0 && shares > 0 ? 'BTC' :
        shares > 0 ? 'BOT' : shares < 0 ? 'SLD' : 'DAY';
    return {
        asof: bar.ending,
        action, quant: quant ? Math.abs(shares) : null, position,
        traded_at: details.reduce((at, exe) => at < exe.asof ? exe.asof : at, '') || null,
        traded_price: shares ? +Big(purchase).add(sold).div(Big(quant).abs()).div(multiplier) : null,
        price: bar.close,
        sales: sold.toFixed(2),
        purchases: purchase.toFixed(2),
        dividend: net_dividend.toFixed(2),
        commission: commission.toFixed(2),
        mtm: +Big(mtm).toFixed(2),
        value: ending_value.toFixed(2)
    };
}

function collectConIds(executions) {
    return executions.reduce((conIds, execution) => {
        if (execution.secType == 'BAG') return conIds;
        const idx = _.sortedIndex(conIds, execution.conId);
        conIds.splice(idx, 0, execution.conId);
        return conIds;
    }, []);
}

async function loadHistoricalData(fetch, symbol, market, begin, options) {
    const tz = (moment.defaultZone||{}).name;
    const asof = moment(options.asof || options.now).format();
    const bars = await fetch(_.defaults({interval:'day', begin, end: asof, symbol, market, tz}, options));
    return bars.filter(bar => bar.ending <= asof);
}

function asSymbol(contract) {
    if (contract.secType == 'FUT' || contract.secType == 'FOP') return fromFutSymbol(contract.localSymbol);
    else if (contract.secType == 'CASH') return contract.symbol;
    else if (contract.secType == 'OPT') return contract.localSymbol;
    else if (!contract.localSymbol) return contract.symbol;
    else return ~contract.localSymbol.indexOf(' ') ? contract.localSymbol.replace(' ', '.') : contract.localSymbol;
}

function fromFutSymbol(symbol) {
    let m, n;
    if (m = symbol.match(/^(\w*)([A-Z])(\d)$/)) {
        const [, root, month, y] = m;
        const now = moment();
        const decade = y >= (now.year() - 2) % 10 ?
            (now.year() - 2).toString().substring(2, 3) :
            (now.year() + 8).toString().substring(2, 3);
        return `${root}${month}${decade}${y}`;
    } else if (n = symbol.match(/^(\w*) +([A-Z]+) (\d\d)$/)) {
        const codes = {JAN: 'F', FEB: 'G', MAR: 'H', APR: 'J', MAY: 'K', JUN: 'M', JUL: 'N', AUG: 'Q', SEP: 'U', OCT: 'V', NOV: 'X', DEC: 'Z'};
        const [, root, month, year] = n;
        return `${root}${codes[month]}${year}`;
    } else {
        return symbol;
    }
}

async function toContract(markets, ib, options) {
    const has_legs = !_.isEmpty(options.attached) && options.attached.some(ord => ord.order_type == 'LEG');
    if (options.symbol && !has_legs) {
        expect(options).to.have.property('symbol').that.is.ok;
        expect(options).to.have.property('market').that.is.oneOf(_.keys(markets));
        const market = markets[options.market];
        return _.omit({
            conId: options.conId,
            localSymbol: toLocalSymbol(market, options.symbol),
            secType: options.security_type || market.secType,
            primaryExch: market.primaryExch || _.first(market.primaryExchs),
            exchange: market.exchange || _.first(market.exchanges),
            currency: market.currency,
            includeExpired: market.secType == 'FUT',
            multiplier: options.multiplier
        }, v => !v);
    } else if (ib != null && options.attached && options.attached.length) {
        const contracts = await Promise.all(options.attached.map(async(attach) => {
            return toContractWithId(markets, ib, {...options, attached: [], ...attach});
        }));
        const currencies = _.uniq(contracts.map(leg => leg.currency));
        if (currencies.length > 1) throw Error(`Cannot mix ${currencies.join(' and ')} in the same Combo order`);
        const exchanges = _.uniq(contracts.map(leg => leg.exchange));
        return {
            secType: 'BAG',
            symbol: _.first(_.uniq(contracts.map(leg => leg.symbol))),
            currency: _.first(currencies),
            exchange: exchanges.length < 2 ? _.first(exchanges) : 'SMART',
            comboLegs: options.attached.map((leg, i) => {
                const contract = contracts[i];
                return {
                    action: leg.action,
                    ratio: leg.quant,
                    conId: contract.conId,
                    exchange: contract.exchange
                };
            })
        };
    } else {
        expect(options).to.have.property('symbol').that.is.ok;
        expect(options).to.have.property('attached').that.is.an('array');
        throw Error(`Could not create contract from ${util.inspect(contract, {breakLength:Infinity})}`);
    }
}

async function toContractWithId(markets, ib, options) {
    const contract = await toContract(markets, null, options);
    if (contract.conId) return contract;
    const details = await ib.reqContractDetails(contract);
    if (details.length) return _.first(details).summary;
    else throw Error(`Could not determin contract from ${util.inspect(contract, {breakLength:Infinity})}`);
}

function toLocalSymbol(market, symbol) {
    if (market.secType == 'FUT') return toFutSymbol(market, symbol);
    else if (market.secType == 'CASH') return toCashSymbol(market, symbol);
    else if (market.secType == 'OPT') return symbol;
    else if (market.secType) return symbol;
    else if (symbol.match(/^(.*)([A-Z])(\d)(\d)$/)) return toFutSymbol(market, symbol);
    else return symbol;
}

function toSymbol(market, detail) {
    if (detail.secType == 'FUT') return fromFutSymbol(market, detail.localSymbol);
    else if (detail.secType == 'CASH') return detail.symbol;
    else if (detail.secType == 'OPT') return detail.localSymbol;
    else return ~detail.localSymbol.indexOf(' ') ? detail.localSymbol.replace(' ', '.') : detail.localSymbol;
}

function toFutSymbol(market, symbol) {
    if ((market||{}).month_abbreviation) {
        const abbreviations = {F: 'JAN', G: 'FEB', H: 'MAR', J: 'APR', K: 'MAY', M: 'JUN', N: 'JUL', Q: 'AUG', U: 'SEP', V: 'OCT', X: 'NOV', Z: 'DEC'};
        const m = symbol.match(/^(\w*)([A-Z])(\d)(\d)$/);
        if (!m) return symbol;
        const [, root, code, decade, year] = m;
        const space = '    '.substring(root.length);
        return `${root}${space} ${abbreviations[code]} ${decade}${year}`;
    } else {
        return symbol.replace(/^(.*)([A-Z])(\d)(\d)( [CP]\d+)?$/,'$1$2$4');
    }
}

function toCashSymbol(market, symbol) {
    return `${symbol}.${market.currency}`;
}

async function asMarket(markets, ib, contract) {
    const market = [contract.primaryExchange, contract.exchange]
      .filter(market => market && market != 'SMART')
      .concat(Object.keys(markets))
      .find(name => {
        if (!markets[name]) return false;
        const currency = markets[name].currency;
        if (currency && currency != contract.currency) return false;
        // secType filter
        const secType = markets[name].secType;
        if (secType && secType != contract.secType) return false;
        const secTypes = markets[name].secTypes;
        if (secTypes && !~secTypes.indexOf(contract.secType)) return false;
        // primaryExch filter
        const primaryExch = markets[name].primaryExch;
        if (primaryExch && primaryExch != contract.primaryExch &&
            primaryExch != contract.exchange) return false;
        const primaryExchs = markets[name].primaryExchs;
        if (primaryExchs && !~primaryExchs.indexOf(contract.primaryExch) &&
            !~primaryExchs.indexOf(contract.exchange)) return false;
        // exchange filter
        const exchange = markets[name].exchange;
        if (exchange && exchange != 'SMART' && exchange != 'IDEALPRO' &&
            contract.exchange != 'SMART' && contract.exchange != 'IDEALPRO' &&
            exchange != contract.exchange && exchange != contract.primaryExch) return false;
        const exchanges = markets[name].exchanges;
        if (exchanges && contract.exchange != 'SMART' && contract.exchange != 'IDEALPRO' &&
            !exchanges.indexOf(contract.exchange) && !exchanges.indexOf(contract.primaryExch)) return false;
        return true;
    });
    if (market) return market;
    const details = ib ? await ib.reqContractDetails(contract.conId ? {conId: contract.conId} : contract)
      .catch(err => []): [];
    return details.reduce(async(promise, detail) => {
        const prior = await promise.catch(err => err);
        if (!(prior instanceof Error)) return prior;
        else return asMarket(markets, null, detail.summary).catch(err => Promise.reject(prior));
    }, Promise.reject(Error(`Could not determine market for ${util.inspect(contract, {breakLength:Infinity})}`)));
}

function parseTime(time, ib_tz) {
    const time_str = time.replace(/^(\d\d\d\d)(\d\d)(\d\d)(\s)?\s*/, '$1-$2-$3$4');
    return moment.tz(time_str, ib_tz).tz((moment.defaultZone||{}).name || moment.tz.guess());
}
