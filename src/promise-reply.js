// promise-reply.js
/*
 *  Copyright (c) 2016-2018 James Leigh, Some Rights Reserved
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
const AssertionError = require('chai').AssertionError;

process.setMaxListeners(process.getMaxListeners()+1);

module.exports = function(process) {
    let seq = 0;
    const handlers = {};
    let quitting = false;
    const onquit = error => {
        quitting = true;
        _.compact(queue.keys().map(id => queue.remove(id))).forEach(pending => {
            pending.onerror(error);
        });
        if (process.connected) process.disconnect();
    };
    const ondisconnect = [];
    const queue = createQueue(onquit, process.pid);
    const stats = {};
    process.setMaxListeners(0);
    process.on('disconnect', () => {
        try {
            queue.abort(Error("Disconnecting " + process.pid));
        } finally {
            ondisconnect.forEach(fn => fn());
        }
    }).on('error', err => {
        queue.abort(err);
    }).on('message', msg => {
        if (msg.cmd && msg.cmd.indexOf('reply_to_') === 0 && queue.has(msg.in_reply_to)) {
            inc(stats, msg.cmd.substring('reply_to_'.length), 'replies_rec');
            const pending = queue.remove(msg.in_reply_to);
            try {
                if (!_.has(msg, 'error')) {
                    return pending.onresponse(msg.payload);
                } else if (!_.isObject(msg.error)) {
                    const stack = (pending.called_from.stack || pending.called_from).toString();
                    const message = stack.replace(/(Error: )?called_from/, msg.error);
                    return pending.onerror(Error(message));
                } else if (msg.error.name == 'AssertionError') {
                    const stack = (pending.called_from.stack || pending.called_from).toString();
                    const message = stack.replace(/(Error: )?called_from/, msg.error.stack);
                    return pending.onerror(new AssertionError(message, msg.error));
                } else {
                    const stack = (pending.called_from.stack || pending.called_from).toString();
                    const message = stack.replace(/(Error: )?called_from/, msg.error.stack || msg.error.message);
                    return pending.onerror(Error(message));
                }
            } catch (err) {
                return pending.onerror(err);
            }
        } else if (handlers[msg.cmd]) {
            inc(stats, msg.cmd, 'requests_rec');
            new Promise(cb => cb(handlers[msg.cmd].call(self, msg.payload))).then(response => {
                if (msg.id && process.connected) inc(stats, msg.cmd, 'replies_sent') && process.send({
                    cmd: 'reply_to_' + msg.cmd,
                    in_reply_to: msg.id,
                    payload: response
                });
            }, err => {
                if (msg.id && process.connected) inc(stats, msg.cmd, 'replies_sent') && process.send({
                    cmd: 'reply_to_' + msg.cmd,
                    in_reply_to: msg.id,
                    error: serializeError(err)
                });
            }).catch(err => {
                if (process.connected) {
                    logger.debug("Could not send", msg.cmd, "message to", process.pid, err, err.stack);
                    process.disconnect();
                }
            });
        } else if (msg.cmd == 'config') {
            // handled by config.js
        } else if (!quitting && msg.cmd && msg.id && msg.cmd.indexOf('reply_to_') != 0 && process.connected) {
            inc(stats, msg.cmd || 'unknown', 'messages_rec');
            logger.debug("Unhandled message command", msg);
            inc(stats, msg.cmd, 'replies_sent') && process.send({
                cmd: 'reply_to_' + msg.cmd,
                in_reply_to: msg.id,
                error: serializeError(Error("Unhandled message command"))
            });
        } else if (!quitting) {
            logger.debug("Unknown message", msg);
        }
    });
    let self;
    return self = {
        stats: stats,
        get connected() {
            return process.connected;
        },
        disconnect() {
            return new Promise(disconnected => {
                if (!process.connected) return disconnected();
                ondisconnect.push(disconnected);
                return process.disconnect();
            });
        },
        kill: process.kill.bind(process),
        on: function(event, listener) {
            process.on(event, listener.bind(this));
            return this;
        },
        once: function(event, listener) {
            process.once(event, listener.bind(this));
            return this;
        },
        async send(cmd, payload) {
            inc(stats, cmd, 'messages_sent');
            if (process.connecting)
                await new Promise((ready, fail) => process.once('connect', ready).once('error', fail));
            return new Promise(cb => process.send({
                cmd: cmd,
                payload: payload
            }, cb)).then(err => {
                if (err) throw err;
            });
        },
        async request(cmd, payload) {
            inc(stats, cmd, 'requests_sent');
            if (process.connecting)
                await new Promise((ready, fail) => process.once('connect', ready).once('error', fail));
            const called_from = new Error("called_from");
            return new Promise((response, error) => {
                const id = nextId(cmd);
                queue.add(id, {
                    onresponse: response,
                    onerror: error,
                    called_from,
                    cmd: cmd,
                    payload: payload
                });
                process.send({
                    cmd: cmd,
                    id: id,
                    payload: payload
                }, err => {
                    if (err) error(err);
                });
            });
        },
        handle(cmd, handler) {
            handlers[cmd] = handler;
            return this;
        },
        removeHandler(cmd, handler) {
            if (!handlers[cmd] || handler && handler != handlers[cmd])
                return false;
            delete handlers[cmd];
            return true;
        },
        pending() {
            return queue.pending().map(item => ({cmd: item.cmd, label: item.payload.label, location: process.pid, options: item.payload}));
        },
        process: process
    };

    function nextId(prefix) {
        let id;
        do {
            id = prefix + (++seq).toString(16);
        } while(queue.has(id));
        return id;
    }
};

let monitor;
let instances = [];

process.setMaxListeners(process.getMaxListeners()+1);

process.on('SIGINT', () => {
    const error = Error('SIGINT');
    instances.forEach(queue => {
        queue.abort(error);
    });
}).on('SIGTERM', () => {
    const error = Error('SIGTERM');
    instances.forEach(queue => {
        queue.abort(error);
    });
}).on('SIGHUP', () => {
    instances.forEach(queue => {
        queue.reload();
    });
}).on('unhandledRejection', (reason, p) => {
    if (!reason || !reason.message || reason.message!='SIGINT' && reason.message!='SIGTERM' && !~reason.message.indexOf('Disconnecting') && !~reason.message.indexOf("Workers have closed")) {
        logger.warn('Unhandled Rejection', reason && reason.message || reason || p, reason && reason.stack || '');
    }
}).on('rejectionHandled', (p) => {
    logger.warn('Rejection Handled', p);
});

function inc(stats, cmd, opt) {
    return stats[opt] = (stats[opt] || 0) + 1;
}

function createQueue(onquit, pid) {
    const outstanding = {};
    let closed = false;
    const queue = {
        add(id, pending) {
            if (closed) throw Error("Disconnected");
            outstanding[id] = _.extend({}, pending);
            if (!monitor) monitor = setInterval(() => {
                const outstanding = _.flatten(instances.map(o => _.values(o.outstanding)));
                if (_.isEmpty(outstanding)) {
                    clearInterval(monitor);
                    monitor = null;
                } else {
                    const marked = _.filter(outstanding, 'marked');
                    const labels = _.uniq(marked.map(label));
                    if (!_.isEmpty(labels))
                        logger.info("Still processing", labels.join(' and '), "from process", pid);
                    _.reject(marked, 'logged').forEach(pending => {
                        logger.trace("Waiting on", pid, "for", label(pending), pending.payload);
                        pending.logged = true;
                    });
                    _.forEach(outstanding, pending => {
                        pending.marked = true;
                    });
                }
            }, 60000);
        },
        has(id) {
            return _.has(outstanding, id);
        },
        remove(id) {
            try {
                return outstanding[id];
            } finally {
                delete outstanding[id];
                if (monitor && _.isEmpty(_.flatten(instances.map(o => _.values(o.outstanding))))) {
                    clearInterval(monitor);
                    monitor = null;
                }
            }
        },
        keys() {
            return _.keys(outstanding);
        },
        pending() {
            return _.values(outstanding);
        },
        abort(err) {
            queue.close();
            return onquit(err);
        },
        reload() {
            _.filter(outstanding, 'logged').forEach(pending => {
                logger.trace("Waiting on", pid, "for", label(pending), pending.payload);
            });
        },
        close() {
            closed = true;
            const idx = instances.indexOf(queue);
            if (idx >= 0) {
                instances.splice(1, idx);
            }
            if (_.isEmpty(instances) && monitor) {
                clearInterval(monitor);
                monitor = null;
            }
        }
    };
    instances.push(queue);
    return queue;
}

function label(pending) {
    if (pending.payload && pending.payload.label)
        return pending.payload.label;
    else return pending.cmd;
}

function serializeError(err) {
    try {
        if (err && _.isFunction(err.toJSON))
            return err.toJSON();
    } catch (e) {
        console.error("Could not serialize error", e, e.stack);
    }
    if (err && err.stack)
        return err.stack;
    return err && err.message || err || true;
}
