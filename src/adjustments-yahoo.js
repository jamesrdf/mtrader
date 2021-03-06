// adjustments-yahoo.js
/*
 *  Copyright (c) 2018-2020 James Leigh, Some Rights Reserved
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

const path = require('path');
const _ = require('underscore');
const moment = require('moment-timezone');
const Big = require('big.js');
const share = require('./share.js');
const logger = require('./logger.js');
const config = require('./config.js');
const storage = require('./storage.js');
const Yahoo = require('./yahoo-client.js');
const like = require('./like.js');
const expect = require('chai').use(like).expect;
const version = require('./version.js');

function help() {
    return [{
        symbol: {
            description: "Ticker symbol used by the market"
        },
        market: {
            description: "Exchange market acronym",
            values: config('fetch.yahoo.markets')
        },
        yahoo_symbol: {
            description: "Symbol for security as used by The Yahoo! Network"
        },
        begin: {
            example: "YYYY-MM-DD",
            description: "Sets the earliest date to retrieve"
        },
        end: {
            example: "YYYY-MM-DD",
            description: "Sets the latest date to retrieve"
        },
        tz: {
            description: "Timezone of the market formatted using the identifier in the tz database"
        },
        now: {
            usage: '<timestamp>',
            description: "The current date/time this request is started"
        },
        offline: {
            usage: 'true',
            description: "If only the local data should be used in the computation"
        }
    }];
}

module.exports = share(function(settings = {}, yahooClient = null) {
    const helpInfo = help();
    const salt = config('salt') || '';
    const cache_dir = config('cache_dir') || path.resolve(config('prefix'), config('default_cache_dir'));
    const dir = path.resolve(config('prefix'), settings.cache_dir || cache_dir);
    const stores = {};
    const markets = config('markets');
    const symbol = yahoo_symbol.bind(this, markets);
    const yahoo = yahooClient || Yahoo();
    return _.extend(async(options) => {
        if (options.info=='help') return helpInfo;
        if (options.info=='version') return [{version:version.toString()}];
        if (options.info) return [];
        else if (options.market && !markets[options.market]) return Promise.resolve([]);
        const market = options.market || '';
        const store = stores[market] = stores[market] || storage(path.resolve(dir, market || ''));
        return store.open(options.symbol, async(err, db) => {
            if (err) throw err;
            const data = await adjustments(yahoo, db, salt, symbol(options), options);
            return filterAdj(data, options);
        });
    }, {
        close() {
            return Promise.all([!yahooClient && yahoo.close()].concat(_.keys(stores).map(market => stores[market].close())));
        }
    });
});

function yahoo_symbol(markets, options) {
    if (options.yahoo_symbol) {
        expect(options).to.be.like({
            yahoo_symbol: /^\S+$/
        });
        return options.yahoo_symbol;
    } else if (markets[options.market] && markets[options.market].datasources.yahoo) {
        expect(options).to.be.like({
            symbol: /^\S+$/
        });
        const source = markets[options.market].datasources.yahoo;
        const suffix = source.yahooSuffix || '';
        if (!suffix && options.symbol.match(/^\w+$/))
            return options.symbol;
        else
            return options.symbol
                .replace(/\^/, '-P')
                .replace(/[\.\-\/]/, '-')
                .replace(/-PR./, '-P')
                .replace(/\./g, '') +
                suffix;
    } else {
        expect(options).to.be.like({
            symbol: /^\S+$/
        });
        return options.symbol;
    }
}

async function yahoo_adjustments(yahoo, db, salt, symbol, options) {
    expect(options).to.have.property('begin');
    expect(options).to.have.property('tz');
    const mbegin = moment.tz(options.begin, options.tz);
    const since = Math.floor(mbegin.year()/10)+'0-01-01';
    const begin = mbegin.format('YYYY-MM-DD');
    const col = await db.collection('adjustments');
    return col.lockWith([since], async() => {
        if (options.offline && col.exists(since))
            return col.readFrom(since);
        else if (options.offline)
            throw Error(`Could not read adjustments, try again without the offline flag ${err.message}`);
        else if (fresh(col, salt, since, options))
            return col.readFrom(since);
        const asof = moment().tz(options.tz);
        return Promise.resolve().then(async() => {
            const splits = await yahoo.split(symbol, since, options.tz);
            const divs = await yahoo.dividend(symbol, since, options.tz);
            const data = _.sortBy(splits.concat(divs), 'Date');
            return writeAdjPrice(yahoo, salt, symbol, col, since, data, options);
        }).then(data => {
            col.propertyOf(since, 'version', version.major_version);
            col.propertyOf(since, 'salt', salt);
            col.propertyOf(since, 'tz', options.tz);
            col.propertyOf(since, 'asof', asof);
            return data;
        }).catch(err => {
            if (!col.exists(since)) throw err;
            else return col.readFrom(since).then(data => {
                logger.warn("Could not load adjustments", symbol, err.message);
                return data;
            }, e2 => Promise.reject(err));
        });
    });
}

function fresh(collection, salt, since, options) {
    if (!compatible(collection, salt, since, options)) return false;
    const mend = moment.tz(options.end || options.now, options.tz);
    const asof = moment.tz(collection.propertyOf(since, 'asof'), options.tz);
    return mend.diff(asof, 'hours') < 4;
}

async function writeAdjPrice(yahoo, salt, symbol, col, since, data, options) {
    if (compatible(col, salt, since, options) && col.sizeOf(since) == data.length) return col.readFrom(since);
    const prices = await yahoo.day(symbol, since, options.tz);
    const mapped = data.map(datum => {
        const prior = prices[_.sortedIndex(prices, datum, 'Date')-1];
        return _.extend(datum, {
            Dividends: datum.Dividends || null,
            'Stock Splits': datum['Stock Splits'] || null,
            cum_close: prior && +prior.Close || undefined
        });
    });
    return col.writeTo(mapped, since);
}

function compatible(collection, salt, since, options) {
    if (!collection.exists(since)) return false;
    if (salt != collection.propertyOf(since, 'salt')) return false;
    if (options.tz != collection.propertyOf(since, 'tz')) return false;
    return collection.propertyOf(since, 'version') == version.major_version;
}

async function adjustments(yahoo, db, salt, symbol, options) {
    const data = await yahoo_adjustments(yahoo, db, salt, symbol, options);
    let adj = Big(1), adj_dividend_only = Big(1), adj_split_only = Big(1);
    let adj_yahoo_divs = Big(1);
    return data.reduceRight((adjustments, datum) => {
        const exdate = datum.Date;
        let dividend = Big(datum.Dividends||0).times(adj_yahoo_divs||0);
        let split = parseSplit(datum['Stock Splits']);
        if (adjustments.length && _.last(adjustments).exdate == exdate) {
            const last = adjustments.pop();
            dividend = dividend.add(last.dividend);
            split = split.times(last.split);
            // check if split is a manual adjustment for a big dividend
            if (!dividend.eq(0) && split.gt(1) && split.lte(2)) { // XLF.ARCA 2016-09-19
                if (adjustments.length) {
                    adj_dividend_only = Big(_.last(adjustments).adj_dividend_only);
                    adj_split_only = Big(_.last(adjustments).adj_split_only);
                    adj = Big(_.last(adjustments).adj);
                } else {
                    adj_dividend_only = Big(1);
                    adj_split_only = Big(1);
                    adj = Big(1);
                }
                adj_yahoo_divs = adj_yahoo_divs.times(split);
                adj_split_only = adj_split_only.div(split);
                split = Big(1);
            }
        }
        // check if split is large enough for yahoo to change it dividends
        if (split.gte(3) || split.lt(Big(1).div(3))) {
            // AAPL.NASDAQ 2014-06-09 not anymore as of 2019-01-11, but again in 2019-07-01
            // REM.ARCA 2016-11-07
            adj_yahoo_divs = adj_yahoo_divs.times(split);
        }
        if (!split.eq(1)) {
            adj_split_only = adj_split_only.div(split);
            adj = adj.div(split);
        }
        const cum_close = Big(datum.cum_close||0).div(adj_split_only);
        if (!dividend.eq(0) && !Big(datum.cum_close||0).eq(0)) {
            adj_dividend_only = adj_dividend_only.times(Big(cum_close).minus(dividend)).div(cum_close);
            adj = adj.times(Big(cum_close).minus(dividend)).div(cum_close);
        }
        adjustments.push({ exdate, dividend, split, cum_close, adj, adj_dividend_only, adj_split_only });
        return adjustments;
    }, []).reverse();
}

/*
 * Number of shares after the split for every share before the split.
 * Returns X where X is X-to-1 split.
 * A reverse split is indicated by a number between 0 and 1.
 */
function parseSplit(stock_splits) {
    if (!stock_splits) return Big(1);
    const splits = ~stock_splits.indexOf('/') ?
        stock_splits.split('/').reverse() : stock_splits.split(':');
    // TRI.TO 2018-11-27 Stock Splits of 1/0
    if (!+splits[0] || !+splits[1]) return Big(1);
    else return Big(splits[0]).div(splits[1]);
}

function filterAdj(adjustments, options) {
    if (!adjustments.length) return adjustments;
    const begin = moment.tz(options.begin, options.tz).format('YYYY-MM-DD');
    if (_.first(adjustments).exdate >= begin) return adjustments;
    else return adjustments.filter(datum => datum.exdate >= begin);
}

