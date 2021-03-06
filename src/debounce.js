// debounce.js
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

/**
 * Creates and returns a new debounced version of the passed function which will
 * postpone its execution until after wait milliseconds have elapsed since the
 * last time it was invoked or until max number if invocation since the last
 * execution.
 * @param func the to wrap
 * @param wait number of milliseconds to wait before invoking
 * @param max the number of attempted invocation before giving up on waiting
 */
module.exports = function(func, wait, max) {
    let timeout, args, context, timestamp, result;
    let counter = 0;

    const later = function() {
      const last = Date.now() - timestamp;

      if (last < wait && last >= 0 && (!max || counter < max)) {
        timeout = setTimeout(later, wait - last);
      } else {
        timeout = null;
        result = func.apply(context, args);
        counter = 0;
        if (!timeout) context = args = null;
      }
    };

    const self = function() {
      context = this;
      args = arguments;
      counter++;
      timestamp = Date.now();
      if (!timeout) timeout = setTimeout(later, wait);
      return result;
    };
    self.flush = function() {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
            result = func.apply(context, args);
            if (!timeout) context = args = null;
        }
        return Promise.resolve(result);
    };
    self.close = function() {
        if (timeout) {
            clearTimeout(timeout);
            result = func.apply(context, args);
        }
        return Promise.resolve(result);
    };
    return self;
  };
