// strategize.spec.js
/*
 *  Copyright (c) 2018 James Leigh, Some Rights Reserved
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

const path = require('path');
const _ = require('underscore');
const merge = require('../src/merge.js');
const config = require('../src/config.js');
const Fetch = require('../src/fetch.js');
const Quote = require('../src/quote.js');
const Collect = require('../src/collect.js');
const Optimize = require('../src/optimize.js');
const Bestsignals = require('../src/bestsignals.js');
const Strategize = require('../src/strategize.js');
const like = require('./should-be-like.js');
const createTempDir = require('./create-temp-dir.js');

describe("strategize", function() {
    this.timeout(240000);
    var fetch, quote, collect, optimize, bestsignals, strategize;
    before(function() {
        config('prefix', path.resolve(__dirname, '../tmp/strategize'));
        fetch = Fetch(merge(config('fetch'), {
            files: {
                enabled: true,
                dirname: path.resolve(__dirname, 'data')
            }
        }));
        quote = new Quote(fetch);
        collect = new Collect(fetch, quote);
        optimize = new Optimize(collect);
        bestsignals = new Bestsignals(optimize);
        strategize = new Strategize(bestsignals);
    });
    beforeEach(function() {
        optimize.seed(27644437);
        strategize.seed(27644437);
    });
    after(function() {
        config.unset('prefix');
        return Promise.all([
            strategize.close(),
            bestsignals.close(),
            optimize.close(),
            collect.close(),
            quote.close(),
            fetch.close()
        ]);
    });
    it.skip("should find best trend cross signal", function() {
        return strategize({
            portfolio: 'SPY.NYSE',
            begin: '2016-10-01',
            end: '2016-12-31',
            strategy_variable: 'strategy',
            max_operands: 1,
            eval_score: 'profit',
            fast_arithmetic: true,
            columns: {
                date: 'DATE(ending)',
                change: 'close - PREV("close")',
                close: 'day.adj_close',
                profit: 'PREC("profit") + change * PREV("strategy")'
            },
            signalset: {
                signals: ['sma_cross'],
                variables: {
                    sma_cross: 'SIGN(SMA(fast_len,day.adj_close)-SMA(slow_len,day.adj_close))'
                },
                parameters: {
                    fast_len: 50,
                    slow_len: 200
                },
                parameter_values: {
                    fast_len: [1,5,10,15,20,25,50],
                    slow_len: [20,25,50,80,100,150,200]
                },
                eval_validity: 'fast_len < slow_len'
            }
        }).should.eventually.be.like({
            variables: {
                strategy: /sma_crossA/
            },
            parameters: {
                fast_lenA: /25|50/,
                slow_lenA: /100|200/
            }
        });
    });
    it("should avoid conflicting variables", function() {
        return strategize({
            portfolio: {
                portfolio: 'SPY.NYSE',
                columns: {
                    date: 'DATE(ending)',
                    close: 'day.adj_close',
                    signal: '0'
                }
            },
            begin: '2016-10-01',
            end: '2016-12-31',
            strategy_variable: 'strategy',
            max_operands: 1,
            eval_score: 'profit',
            fast_arithmetic: true,
            description: "The variable signal should not be used by strategize and always be zero",
            columns: {
                date: 'date',
                _change: 'close - PREV("close")',
                close: 'close',
                profit: 'PREC("profit") + _change * PREV("strategy") - 100 * signal'
            },
            signalset: {
                signals: ['sma_cross'],
                variables: {
                    sma_cross: 'SIGN(SMA(fast_len,day.adj_close)-SMA(slow_len,day.adj_close))'
                },
                parameters: {
                    fast_len: 50,
                    slow_len: 200
                },
                parameter_values: {
                    fast_len: [1,5,10,15,20,25,50],
                    slow_len: [20,25,50,80,100,150,200]
                },
                eval_validity: 'fast_len < slow_len'
            }
        }).should.eventually.be.like({
            variables: {
                strategy: /sma_crossA/
            }
        });
    });
    it("should find complex strategy", function() {
        return strategize({
            portfolio: 'SPY.NYSE',
            begin: '2011-01-01',
            end: '2011-12-31',
            strategy_variable: 'strategy',
            max_operands: 2,
            population_size: 4,
            disjunction_cost: 1,
            eval_score: 'profit',
            fast_arithmetic: true,
            columns: {
                date: 'DATE(ending)',
                change: 'close - PREV("close")',
                close: 'day.adj_close',
                profit: 'PREC("profit") + change * PREV("strategy")'
            },
            signalset: [{
                signals: ['trend'],
                variables: {
                    trend: "IF(high=low, high, 0)",
                    high: "DIRECTION(trend_len,highest)",
                    low: "DIRECTION(trend_len,lowest)",
                    highest: "HIGHEST(trend_len,day.high*scale)",
                    lowest: "LOWEST(trend_len,day.low*scale)",
                    scale: "day.adj_close/day.close"
                },
                parameters: {
                    trend_len: 50,
                },
                parameter_values: {
                    trend_len: [5,10,20,50]
                }
            }]
        }).should.eventually.be.like({
            variables: {
                strategy: '-trendA OR -trendB'
            },
            parameters: {
                trend_lenA: 5, trend_lenB: 50,
            },
            score: 30.280018
        });
    });
    it("should find complex conjunction strategy", function() {
        return strategize({
            portfolio: 'SPY.NYSE',
            begin: '2011-01-01',
            end: '2011-12-31',
            strategy_variable: 'strategy',
            max_operands: 2,
            population_size: 4,
            conjunctions_only: true,
            eval_score: 'profit',
            fast_arithmetic: true,
            columns: {
                date: 'DATE(ending)',
                change: 'close - PREV("close")',
                close: 'day.adj_close',
                profit: 'PREC("profit") + change * PREV("strategy")'
            },
            signalset: [{
                signals: ['trend'],
                variables: {
                    trend: "IF(high=low, high, 0)",
                    high: "DIRECTION(trend_len,highest)",
                    low: "DIRECTION(trend_len,lowest)",
                    highest: "HIGHEST(trend_len,day.high*scale)",
                    lowest: "LOWEST(trend_len,day.low*scale)",
                    scale: "day.adj_close/day.close"
                },
                parameters: {
                    trend_len: 50,
                },
                parameter_values: {
                    trend_len: [5,10,20,50]
                }
            }]
        }).should.eventually.be.like({
            variables: {
                strategy: 'trendA!=0 AND -trendB'
            },
            parameters: {
                trend_lenA: 20, trend_lenB: 5
            },
            score: 22.554602
        });
    });
    it("should find dip buying opportunities", function() {
        return strategize({
            portfolio: 'SPY.NYSE',
            begin: '2011-01-01',
            end: '2011-12-31',
            strategy_variable: 'strategy',
            max_operands: 3,
            population_size: 4,
            eval_score: 'profit',
            fast_arithmetic: true,
            transient: false,
            columns: {
                date: 'DATE(ending)',
                change: 'close - PREV("close")',
                close: 'day.adj_close',
                profit: 'PREC("profit") + change * PREV("strategy")'
            },
            signalset: [{
                signals: ['trend'],
                variables: {
                    trend: "IF(high=low, high, 0)",
                    high: "DIRECTION(trend_len,highest)",
                    low: "DIRECTION(trend_len,lowest)",
                    highest: "HIGHEST(trend_len,day.high*scale)",
                    lowest: "LOWEST(trend_len,day.low*scale)",
                    scale: "day.adj_close/day.close"
                },
                parameter_values: {
                    trend_len: [5,50,150]
                }
            }]
        }).should.eventually.be.like({
            variables: {
                strategy: '-trendA OR trendB!=-trendC AND -trendC'
            },
            parameters: { trend_lenA: 5, trend_lenB: 150, trend_lenC: 50 },
            score: 34.095606
        });
    });
    it("should find dip buying disjunction opportunities", function() {
        return strategize({
            portfolio: 'SPY.NYSE',
            begin: '2011-01-01',
            end: '2011-12-31',
            strategy_variable: 'strategy',
            max_operands: 3,
            disjunctions_only: true,
            population_size: 4,
            eval_score: 'profit',
            fast_arithmetic: true,
            transient: false,
            columns: {
                date: 'DATE(ending)',
                change: 'close - PREV("close")',
                close: 'day.adj_close',
                profit: 'PREC("profit") + change * PREV("strategy")'
            },
            signalset: [{
                signals: ['trend'],
                variables: {
                    trend: "IF(high=low, high, 0)",
                    high: "DIRECTION(trend_len,highest)",
                    low: "DIRECTION(trend_len,lowest)",
                    highest: "HIGHEST(trend_len,day.high*scale)",
                    lowest: "LOWEST(trend_len,day.low*scale)",
                    scale: "day.adj_close/day.close"
                },
                parameter_values: {
                    trend_len: [5,50,150]
                }
            }]
        }).should.eventually.be.like({
            variables: {
                strategy: '-trendA OR -trendB OR trendC'
            },
            parameters: { trend_lenA: 5, trend_lenB: 50, trend_lenC: 150 },
            score: 31.630024
        });
    });
    it.skip("should reuse existing variable", function() {
        return strategize({
            portfolio: 'SPY.NYSE',
            begin: '2016-10-01',
            end: '2016-12-31',
            strategy_variable: 'strategy',
            max_operands: 1,
            eval_score: 'profit',
            fast_arithmetic: true,
            columns: {
                date: 'DATE(ending)',
                change: 'close - PREV("close")',
                close: 'day.adj_close',
                profit: 'PREC("profit") + change * PREV("strategy")'
            },
            variables: {
                sma_crossA: 'SIGN(SMA(fast_lenA,day.adj_close)-SMA(slow_lenA,day.adj_close))',
                sma_crossB: 'SIGN(SMA(fast_lenB,day.adj_close)-SMA(slow_lenB,day.adj_close))'
            },
            parameters: {
                fast_lenA: 50,
                slow_lenA: 200,
                fast_lenB: 25,
                slow_lenB: 100
            },
            signalset: {
                signals: ['sma_cross'],
                variables: {
                    sma_cross: 'SIGN(SMA(fast_len,day.adj_close)-SMA(slow_len,day.adj_close))'
                },
                parameters: {
                    fast_len: 50,
                    slow_len: 200
                },
                parameter_values: {
                    fast_len: [1,5,10,15,20,25,50],
                    slow_len: [20,25,50,80,100,150,200]
                },
                eval_validity: 'fast_len < slow_len'
            }
        }).should.eventually.be.like({
            variables: {
                strategy: 'sma_crossB'
            },
            parameters: {
                fast_lenB: 25,
                slow_lenB: 100
            },
            score: 14.186871
        });
    });
});

