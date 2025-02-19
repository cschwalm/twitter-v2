const split = require('split');

const TwitterError = require('./TwitterError.js');

const State = {
  NOT_STARTED: Symbol('NOT_STARTED'),
  STARTED: Symbol('STARTED'),
  CLOSED: Symbol('CLOSED'),
};

class DeferredPromise {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class TwitterStream {
  constructor(connect, close) {
    this._connect = connect;
    this._close = close;

    this._state = State.NOT_STARTED;
    this._events = [new DeferredPromise()];
    this._timeout = null;
  }

  _emit(promise) {
    this._events[this._events.length - 1].resolve(promise);
    this._events.push(new DeferredPromise());
  }

  // As per https://developer.twitter.com/en/docs/labs/v1/filtered-stream/faq
  //
  // When streaming Tweets, the goal is to stay connected for as long as
  // possible, recognizing that disconnects may occur. In Labs, the streaming
  // endpoint does not include a way to recover Tweets that were missed while
  // disconnected. Instead, the endpoint provides a 30-second keep alive
  // heartbeat (it will look like a new line character). Use this signal to
  // detect if you’re being disconnected.
  _refreshTimeout() {
    if (this._state !== State.CLOSED) {
      clearTimeout(this._timeout);
      this._timeout = setTimeout(() => {
        this._closeWithError(new TwitterError('Stream unresponsive'));
      }, 30000);
    }
  }

  _closeWithError(error) {
    if (this._state !== State.CLOSED) {
      this._state = State.CLOSED;
      clearTimeout(this._timeout);
      this._emit(Promise.reject(error));
      this._close();
    }
  }

  [Symbol.asyncIterator]() {
    if (this._state == State.CLOSED) {
      throw new Error('Stream has already been closed.');
    }

    return {
      next: async () => {
        if (this._state == State.NOT_STARTED) {
          this._state = State.STARTED;

          const response = await this._connect();
          const stream = response.body.pipe(split());

          this._refreshTimeout();

          stream.on('data', (line) => {
            this._refreshTimeout();

            if (!line.trim()) {
              return;
            }

            if (line == 'Rate limit exceeded') {
              this._closeWithError(new TwitterError('Rate limit exceeded'));
              return;
            }

            const json = JSON.parse(line);

            const error = TwitterError.fromJson(json);
            if (error) {
              this._closeWithError(error);
              return;
            }

            this._emit(Promise.resolve({ done: false, value: json }));
          });

          stream.on('error', (error) => {
            this._closeWithError(error);
          });

          stream.on('end', (error) => {
            this.close();
          });
        }

        const event = this._events[0];
        return event.promise.finally(() => {
          if (event === this._events[0]) {
            this._events.shift();
          }
        });
      },
    };
  }

  close() {
    if (this._state !== State.CLOSED) {
      this._state = State.CLOSED;
      clearTimeout(this._timeout);
      this._emit(Promise.resolve({ done: true }));
      this._close();
    }
  }
}

module.exports = TwitterStream;
