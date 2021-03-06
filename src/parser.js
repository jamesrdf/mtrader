// parser.js
/*
 *  Copyright (c) 2014-2018 James Leigh, Some Rights Reserved
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
const logger = require('./logger.js');
const expect = require('chai').expect;

/**
 * Given a hash of methods: constant(value), variable(name),
 * expression(expr, name, args) and a substitutions string expression to pre-bind
 * variables with another expression. The methods are expected to return functions, but they
 * can return anything. The parameter args is an array of functions returned by
 * previous calls to one of the given methods.
 */
module.exports = function(handlers) {
    const subs = parseVariables(handlers && handlers.substitutions);
    const _handlers = {
        constant(value) {
            if (!handlers || !handlers.constant) return JSON.stringify(value);
            else return handlers.constant(value);
        },
        variable(name) {
            if (!handlers || !handlers.variable) return name;
            else return handlers.variable(name);
        },
        expression(expr, name, args) {
            if (!handlers || !handlers.expression) return expr;
            else return handlers.expression(expr, name, args);
        }
    };
    return {
        /**
         * @returns function of expr
         */
        parse(expr) {
            const handler = invokeHandler.bind(this, _handlers);
            if (_.isNumber(expr))
                return _handlers.constant(expr);
            else if (_.isString(expr))
                return parseExpression(expr, subs, handler);
            else if (_.isNumber(expr))
                return parseExpression(expr.toString(), subs, handler);
            else if (_.isArray(expr)) {
                const array = expr.map(value => parseExpression(value, subs, handler));
                if (!array.some(isPromise)) return array;
                else return Promise.all(array);
            } else if (_.isObject(expr) && !_.isFunction(expr) && _.allKeys(expr).every(k=>_.has(expr,k))) {
                const values = Object.values(expr).map((value, name) => {
                    try {
                        const ret = parseExpression(value, subs, handler);
                        if (!isPromise(ret)) return ret;
                        else return ret.catch(e => {
                            logger.debug("Could not parse property", name, e);
                            throw Error("Could not parse property " + name + ". " + e.message);
                        });
                    } catch(e) {
                        logger.debug("Could not parse property", name, e);
                        throw Error("Could not parse property " + name + ". " + e.message);
                    }
                });
                if (values.some(isPromise))
                    return Promise.all(values).then(values =>_.object(Object.keys(expr), values));
                else
                    return _.object(Object.keys(expr), values);
            } else {
                expect(expr).to.be.ok.and.a('string');
            }
        },
        /**
         * Produces Array of functions that must each resolve to truthy for the
         * criteria to be considered passing.
         */
        parseCriteriaList(exprs) {
            if (_.isEmpty(exprs)) return [];
            if (!_.isArray(exprs) && !_.isString(exprs)) expect(exprs).to.be.a('string');
            const list = _.isArray(exprs) ?
                _.flatten(exprs.map(val=>parseExpressions(val, subs)), true) :
                parseExpressions(exprs, subs);
            let i=0;
            while (i<list.length) {
                const expr = list[i];
                if (_.first(expr) != 'AND') i++;
                else list.splice(i, 1, expr[1], expr[2]);
            }
            const parsed = list.map(expr => {
                return invokeHandler(_handlers, expr);
            });
            if (parsed.some(isPromise)) return Promise.all(parsed);
            else return parsed;
        }
    };
};

/**
 * Indexes the expressions by their variable names, if they have one
 */
function parseVariables(exprs) {
    if (!exprs) return {};
    const variables = _.mapObject(_.pick(exprs, (val,key)=>val!=key), val => parseExpression(val));
    const handlers = {
        constant(value) {
            return [];
        },
        variable(name) {
            if (variables[name]) return [name];
            else return [];
        },
        expression(expr, name, args) {
            return _.uniq(_.flatten(args, true));
        }
    };
    const references = _.mapObject(variables, (expr, name) => {
        const reference = invokeHandler(handlers, expr);
        if (!_.contains(reference, name)) return reference;
        else throw Error("Expression cannot reference itself: " + name);
    });
    while (_.reduce(references, (more, reference, name) => {
        if (!reference.length) return more;
        const second = _.uniq(_.flatten(reference.map(ref => references[ref]), true));
        if (_.contains(second, name)) throw Error("Circular Reference " + name);
        variables[name] = inline(variables[name], variables);
        references[name] = second;
        return more || second.length;
    }, false));
    return variables;
}

function parseExpression(str, substitutions, handler) {
    const list = parseExpressions(str, substitutions);
    if (!list.length) throw Error("No input: " + str);
    if (list.length > 1) throw Error("Did not expect multiple expressions: " + str);
    try {
        if (handler) return handler(_.first(list));
        else return _.first(list);
    } catch (e) {
        logger.debug(e);
        throw Error(e.message + " in " + str, e);
    }
}

function invokeHandler(handlers, expr) {
    if (_.isArray(expr)) {
        const args = _.rest(expr).map(expr => invokeHandler(handlers, expr));
        if (args.some(isPromise)) {
            return Promise.all(args).then(args => {
                return handlers.expression(serialize(expr), _.first(expr), args);
            }).then(fn => {
                if (!_.isUndefined(fn)) return fn;
                else throw Error("Unknown function: " + _.first(expr));
            });
        } else {
            const fn = handlers.expression(serialize(expr), _.first(expr), args);
            if (isPromise(fn)) {
                return fn.then(fn => {
                    if (!_.isUndefined(fn)) return fn;
                    else throw Error("Unknown function: " + _.first(expr));
                });
            } else {
                if (!_.isUndefined(fn)) return fn;
                else throw Error("Unknown function: " + _.first(expr));
            }
        }
    } else if (_.isString(expr) && expr.charAt(0) == '"') {
        return handlers.constant(JSON.parse(expr));
    } else if (_.isNumber(expr) && _.isFinite(expr)) {
        return handlers.constant(+expr);
    } else {
        return handlers.variable(expr);
    }
}

function isPromise(object) {
    return !!object && !!object.then;
}

function parseExpressions(str, substitutions) {
    const expressions = parseExpressionList(str == null ? '' : str.toString());
    if (_.isEmpty(substitutions)) return expressions;
    else return expressions.map(expr => inline(expr, substitutions));
}

function inline(expr, substitutions) {
    if (_.isArray(expr)) {
        return expr.map((expr, i) => i === 0 ? expr : inline(expr, substitutions));
    } else if (_.isString(expr) && _.has(substitutions, expr)) {
        return substitutions[expr];
    } else {
        return expr;
    }
}

const operators = {
    NEGATIVE: {op: '-', priority: 1},
    NOT: {op: '!', priority: 1},
    MOD: {op: '%', priority: 2},
    DIVIDE: {op: '/', priority: 2, associative: false},
    PRODUCT: {op: '*', priority: 2, associative: true},
    SUBTRACT: {op: '-', priority: 3, associative: false},
    ADD: {op: '+', priority: 3, associative: true},
    GREATER_THAN: {op: '>', priority: 4},
    LESS_THAN: {op: '<', priority: 4},
    NOT_LESS_THAN: {op: '>=', priority: 4},
    NOT_GREATER_THAN: {op: '<=', priority: 4},
    NOT_EQUAL: {op: '!=', priority: 4},
    EQUALS: {op: '=', priority: 4},
    AND: {op: ' AND ', priority: 5, associative: true},
    OR: {op: ' OR ', priority: 6, associative: true}
};

function serialize(expr) {
    if (_.isArray(expr) && operators[_.first(expr)]) {
        const operator = operators[_.first(expr)];
        const exprs = _.rest(expr).map((arg, i) => {
            const aop = operators[_.first(arg)];
            if (!_.isArray(arg) || !aop || aop.priority < operator.priority)
                return serialize(arg);
            else if (aop.priority == operator.priority && operator.associative && typeof aop.associative == 'boolean')
                return serialize(arg); // 1 * 2 / 3 or 1 + 2 - 3, but not 2 * (3%4)
            else if (aop == operator && operator.associative)
                return serialize(arg); // 1 != 2 AND 3 != 4 AND 5
            else return '(' + serialize(arg) + ')';
        });
        if (exprs.length == 1) return operator.op + exprs[0];
        else return exprs.join(operator.op);
    } else if (_.isArray(expr)) {
        return _.first(expr) + '(' + _.rest(expr).map(serialize).join(',') + ')';
    } else if (_.isString(expr) || _.isFinite(expr)) {
        return expr; // string literal, number or variable
    } else {
        throw Error("Unknown expression: " + expr);
    }
}

function parseExpressionList(str) {
    let index = 0;
    try {
        const expressions = [parseExpression()];
        while (peek() == ',') {
            index++;
            expressions.push(parseExpression());
        };
        if (peek()) expect("end of input");
        return expressions;
    } catch (e) {
        throw Error("Could not parse \"" + str + "\". " + e.message);
    }

    function parseExpression() {
        return parseConditionalOrExpression();
    }
    function parseConditionalOrExpression() {
        const lhs = parseConditionalAndExpression();
        if (peek() != 'O' && peek() != 'o') return lhs;
        const or = str.substring(index,index+2);
        if ('OR' != or && 'or' != or || isWord(str[index+2])) return lhs;
        index+= 2;
        return ['OR', lhs, parseConditionalOrExpression()];
    }
    function parseConditionalAndExpression() {
        const lhs = parseLogicalExpression();
        if (peek() != 'A' && peek() != 'a') return lhs;
        const and = str.substring(index,index+3);
        if ('AND' != and && 'and' != and || isWord(str[index+3])) return lhs;
        index+= 3;
        return ['AND', lhs, parseConditionalAndExpression()];
    }
    function parseLogicalExpression() {
        const lhs = parseNumericExpression();
        if (peek() == '=') {
            index++;
            return ['EQUALS', lhs, parseLogicalExpression()];
        } else if (peek() == '!' && str[index+1] == '=') {
            index+= 2;
            return ['NOT_EQUAL', lhs, parseLogicalExpression()];
        } else if (peek() == '<' && str[index+1] == '>') {
            index+= 2;
            return ['NOT_EQUAL', lhs, parseLogicalExpression()];
        } else if (peek() == '<' && str[index+1] == '=') {
            index+= 2;
            return ['NOT_GREATER_THAN', lhs, parseLogicalExpression()];
        } else if (peek() == '>' && str[index+1] == '=') {
            index+= 2;
            return ['NOT_LESS_THAN', lhs, parseLogicalExpression()];
        } else if (peek() == '<') {
            index++;
            return ['LESS_THAN', lhs, parseLogicalExpression()];
        } else if (peek() == '>') {
            index++;
            return ['GREATER_THAN', lhs, parseLogicalExpression()];
        } else {
            return lhs;
        }
    }
    function parseNumericExpression() {
        return parseAdditiveExpression();
    }
    function parseAdditiveExpression() {
        let lhs = parseMultiplicativeExpression();
        while(peek() == '+' || peek() == '-') {
            if (peek() == '+') {
                index++;
                lhs = ['ADD', lhs, parseMultiplicativeExpression()];
            } else if (peek() == '-') {
                index++;
                lhs = ['SUBTRACT', lhs, parseMultiplicativeExpression()];
            }
        }
        return lhs;
    }
    function parseMultiplicativeExpression() {
        let lhs = parseUnaryExpression();
        while(peek() == '*' || peek() == '×' || peek() == '/' || peek() == '%') {
            if (peek() == '*' || peek() == '×') {
                index++;
                lhs = ['PRODUCT', lhs, parseUnaryExpression()];
            } else if (peek() == '/') {
                index++;
                lhs = ['DIVIDE', lhs, parseUnaryExpression()];
            } else if (peek() == '%') {
                index++;
                lhs = ['MOD', lhs, parseUnaryExpression()];
            }
        }
        return lhs;
    }
    function parseUnaryExpression() {
        if (peek() == '!') {
            index++;
            return ['NOT', parseUnaryExpression()];
        } else if (peek() == '+') {
            index++;
            return parseBrackettedExpression();
        } else if (peek() == '-' && isNumber(str[index+1])) {
            return parseNumber();
        } else if (peek() == '-') {
            index++;
            return ['NEGATIVE', parseBrackettedExpression()];
        } else {
            return parseBrackettedExpression();
        }
    }
    function parseBrackettedExpression() {
        if (peek() == '(') {
            expect('(');
            const expr = parseExpression();
            expect(')');
            return expr;
        } else if (isLetter(peek()) || peek() == '_') {
            return parseVariableOrCall();
        } else if (isNumber(peek()) || peek() == '-') {
            return parseNumber();
        } else if (isQuote(peek())) {
            return parseString();
        } else if (peek() == '`') {
            return parseTemplate();
        } else {
            expect("letter, number, or bracket");
        }
    }
    function parseVariableOrCall() {
        let word = parseWord();
        const indicator = peek() == '.';
        if (indicator) {
            index++;
            // fields and indicator functions maybe prefixed with interval
            word = word + '.' + parseWord();
        }
        if (peek() != '(') return word;
        expect('(');
        const args = peek() == ')' ? [] : [parseExpression()];
        while (peek() == ',') {
            index++;
            args.push(parseExpression());
        };
        expect(')');
        return [word].concat(args);
    }
    function parseWord() {
        if (!isWord(peek())) expect("word");
        const start = index;
        while (index < str.length && isWord(str[index]))
            index++;
        return str.substring(start, index);
    }
    function parseString() {
        const quote = peek();
        const start = index;
        if (!isQuote(quote)) expect("quote");
        else expect(quote);
        const buf = ['"'];
        while (index < str.length && str[index] != quote) {
            if (str[index] == '"' || str[index] == '\\' && str[index+1] != "'") buf.push('\\');
            if (str[index] == '\\') index++;
            index++;
            buf.push(str[index -1]);
        }
        buf.push('"');
        expect(quote);
        return JSON.stringify(JSON.parse(buf.join('')));
    }
    function parseTemplate() {
        const start = index;
        if (peek() != '`') expect("back-tick");
        else expect('`');
        let template = parseTemplateLiteral();
        while (peek() == '{') {
            expect('{');
            const expression = parseExpression();
            expect('}');
            const literal = parseTemplateLiteral();
            if (_.isArray(template) && template[0] == 'CONCAT') {
                template.push(expression, literal);
            } else {
                template = ['CONCAT', template, expression, literal];
            }
        }
        expect('`');
        return template;
    }
    function parseTemplateLiteral() {
        const start = index;
        const buf = ['"'];
        while (index < str.length && str[index] != '`' && (str[index] != '{' || str[index+1] == '{')) {
            if (str[index] == '"' || str[index] == '\\' && str[index+1] != '`') buf.push('\\');
            if (str[index] == '\\') index++;
            if (str[index] == '{' && str[index+1] == '{') index++;
            if (str[index] == '}' && str[index+1] == '}') index++;
            index++;
            buf.push(str[index -1]);
        }
        buf.push('"');
        return JSON.stringify(JSON.parse(buf.join('')));
    }
    function parseNumber() {
        if (!isNumber(peek()) && peek() != '-') expect("number");
        const start = index;
        if (peek() == '-') index++;
        if (!isNumber(str[index])) expect("number");
        while(isNumber(str[index])) index++;
        if (str[index] != '.' && str[index] != 'E' && str[index] != 'e')
            return parseInt(str.substring(start, index));
        if (str[index] == '.') index++
        if (!isNumber(str[index]) && str[index] != 'E' && str[index] != 'e')
            expect("number after decimal point");
        while(isNumber(str[index])) index++;
        if (str[index] == 'E' || str[index] == 'e') {
            index++;
            if (str[index] == '+' || str[index] == '-') index++;
            if (!isNumber(str[index])) expect("number after exponent");
            while(isNumber(str[index])) index++;
        }
        return parseFloat(str.substring(start, index));
    }
    function peek() {
        while (isWhiteSpace(str[index])) index++;
        return str[index];
    }
    function isWhiteSpace(chr) {
        return /\s/.test(chr);
    }
    function isQuote(chr) {
        return chr == '"' || chr == "'";
    }
    function isWord(chr) {
        return isNumber(chr) || isLetter(chr) || '_' == chr;
    }
    function isLetter(chr) {
        return 'a' <= chr && chr <= 'z' || 'A' <= chr && chr <= 'Z';
    }
    function isNumber(chr) {
        return '0' <= chr && chr <= '9';
    }
    function expect(chr) {
        if (peek() != chr && index < str.length)
            throw Error("Expected " + chr + ", but got " + str.substring(index, index + 10) + "...");
        if (peek() != chr)
            throw Error("Expected " + chr + ", but no more input");
        return expect[index++];
    }
}
