// Copyright 2015-2017 Parity Technologies (UK) Ltd.
// This file is part of Parity.

// Parity is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Parity is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with Parity.  If not, see <http://www.gnu.org/licenses/>.

import uniq from 'lodash.uniq';
import store from 'store';

import Api from '@parity/api';
import { LOG_KEYS, getLogger } from '@parity/shared/lib/config';

const log = getLogger(LOG_KEYS.Signer);

// Defaults
const JSONRPC_INTERFACE = '127.0.0.1';
const JSONPRC_PORT = '8545';
const WS_INTERFACE = '127.0.0.1';
const WS_PORT = '8546';

export default class SecureApi extends Api {
  _isConnecting = false;
  _needsToken = false;
  _tokens = [];

  _dappsUrl = null;
  _wsUrl = null;

  static getWsProvider (wsUrl, protocol, sysuiToken) {
    const transportUrl = SecureApi.transportWsUrl(wsUrl, protocol);

    return new Api.Provider.Ws(transportUrl, sysuiToken, false);
  }

  static transportWsUrl (url, protocol) {
    const proto = protocol() === 'https:' ? 'wss:' : 'ws:';

    return `${proto}//${url}`;
  }

  // Returns a protocol with `:` at the end.
  static protocol () {
    return window.location.protocol === 'file:'
      ? 'http:'
      : window.location.protocol;
  }

  constructor (urlOptions, nextToken, getProvider = SecureApi.getWsProvider, protocol = SecureApi.protocol) {
    const sysuiToken = store.get('sysuiToken');
    const opts = {
      jsonrpcInterface: JSONRPC_INTERFACE,
      jsonrpcPort: JSONPRC_PORT,
      wsInterface: WS_INTERFACE,
      wsPort: WS_PORT,
      ...urlOptions
    };

    const _dappsUrl = `${opts.jsonrpcInterface}:${opts.jsonrpcPort}`;
    const _wsUrl = `${opts.wsInterface}:${opts.wsPort}`;

    const wsProvider = getProvider(_wsUrl, protocol, sysuiToken);

    super(wsProvider);

    this.protocol = protocol;
    this._dappsUrl = _dappsUrl;
    this._wsUrl = _wsUrl;

    // Try tokens from localStorage, from hash and 'initial'
    this._tokens = uniq([sysuiToken, nextToken, 'initial'])
      .filter((token) => token)
      .map((value) => ({
        value,
        tried: false
      }));

    // When the provider is closed, try to reconnect
    wsProvider.on('close', this.connect, this);

    this.connect();
  }

  get _dappsAddress () {
    if (!this._dappsUrl) {
      return {
        host: null,
        port: 8545
      };
    }

    const [host, port] = this._dappsUrl.split(':');

    return {
      host,
      port: port ? parseInt(port, 10) : null
    };
  }

  get dappsPort () {
    return this._dappsAddress.port;
  }

  get dappsUrl () {
    const { port } = this._dappsAddress;

    return port
      ? `${this.protocol()}//${this.hostname}:${port}`
      : `${this.protocol()}//${this.hostname}`;
  }

  get hostname () {
    if (window.location.hostname === 'home.parity') {
      return 'dapps.parity';
    }

    return this._dappsAddress.host || '127.0.0.1';
  }

  get isConnecting () {
    return this._isConnecting;
  }

  get isConnected () {
    return this.provider.isConnected;
  }

  get needsToken () {
    return this._needsToken;
  }

  get secureToken () {
    return this.provider.token;
  }

  connect () {
    if (this._isConnecting) {
      return;
    }

    log.debug('trying to connect...');

    this._isConnecting = true;

    this.emit('connecting');

    // Reset the tested Tokens
    this._resetTokens();

    // Try to connect
    return this._connect()
      .then((connected) => {
        this._isConnecting = false;

        if (connected) {
          const token = this.secureToken;

          log.debug('got connected ; saving token', token);

          // Save the sucessful token
          this._saveToken(token);
          this._needsToken = false;

          // Emit the connected event
          return this.emit('connected');
        }

        // If not connected, we need a new token
        log.debug('needs a token');
        this._needsToken = true;

        return this.emit('disconnected');
      })
      .catch((error) => {
        this._isConnecting = false;

        log.debug('emitting "disconnected"');
        this.emit('disconnected');
        console.error('unhandled error in secureApi', error);
      });
  }

  /**
   * Resolves a wildcard address to `window.location.hostname`;
   */
  _resolveHost (url) {
    const parts = url ? url.split(':') : [];
    const port = parts[1];
    let host = parts[0];

    if (!host) {
      return host;
    }

    if (host === '0.0.0.0') {
      host = window.location.hostname;
    }

    return port ? `${host}:${port}` : host;
  }

  /**
   * Returns a Promise that gets resolved with
   * a boolean: `true` if the node is up, `false`
   * otherwise (HEAD request to the Node)
   */
  isNodeUp () {
    return fetch(`${this.protocol()}//${this._wsUrl}/api/ping`, { method: 'HEAD' })
      .then(
        (r) => r.status === 200,
        () => false
      )
      .catch(() => false);
  }

  /**
   * Update the given token, ie. add it to the token
   * list, and then try to connect (if not already connecting)
   */
  updateToken (_token) {
    const token = this._sanitiseToken(_token);

    log.debug('updating token', token);

    // Update the tokens list: put the new one on first position
    this._tokens = [{ value: token, tried: false }].concat(this._tokens);

    // Try to connect with the new token added
    return this.connect();
  }

  /**
   * Try to connect to the Node with the next Token in
   * the list
   */
  _connect () {
    log.debug('trying next token');

    // Get the first not-tried token
    const nextToken = this._getNextToken();

    // If no more tokens to try, user has to enter a new one
    if (!nextToken) {
      return Promise.resolve(false);
    }

    nextToken.tried = true;

    return this._connectWithToken(nextToken.value)
      .then((validToken) => {
        // If not valid, try again with the next token in the list
        if (!validToken) {
          return this._connect();
        }

        // If correct and valid token, wait until the Node is ready
        // and resolve as connected
        return this._waitUntilNodeReady()
          .then(() => true);
      })
      .catch((error) => {
        log.error('unknown error in _connect', error);
        return false;
      });
  }

  /**
   * Connect with the given token.
   * It returns a Promise that gets resolved
   * with `validToken` as argument, whether the given token
   * is valid or not
   */
  _connectWithToken (_token) {
    // Sanitize the token first
    const token = this._sanitiseToken(_token);

    // Update the URL and token in the transport layer
    this.transport.url = SecureApi.transportWsUrl(this._wsUrl, this.protocol);
    this.provider.updateToken(token, false);

    log.debug('connecting with token', token);

    const connectPromise = this.provider.connect()
      .then(() => {
        log.debug('connected with', token);

        if (token === 'initial') {
          return this._generateAuthorizationToken();
        }

        // The token is valid !
        return true;
      })
      .catch((error) => {
        // Log if it's not a close error (ie. wrong token)
        if (error && error.type !== 'close') {
          log.debug('did not connect ; error', error);
        }

        return false;
      });

    return Promise
      .all([
        connectPromise,
        this.isNodeUp()
      ])
      .then(([connected, isNodeUp]) => {
        if (connected) {
          return true;
        }

        // If it's not up, try again in a few...
        if (!isNodeUp) {
          const timeout = this.transport.retryTimeout;

          log.debug('node is not up ; will try again in', timeout, 'ms');

          return new Promise((resolve, reject) => {
            window.setTimeout(() => {
              this._connectWithToken(token).then(resolve).catch(reject);
            }, timeout);
          });
        }

        // The token is invalid
        log.debug('tried with a wrong token', token);
        return false;
      });
  }

  /**
   * Try to generate an Authorization Token.
   * Then try to connect with the new token.
   */
  _generateAuthorizationToken () {
    return this.signer
      .generateAuthorizationToken()
      .then((token) => this._connectWithToken(token));
  }

  /**
   * Get the next token to try, if any left
   */
  _getNextToken () {
    // Get the first not-tried token
    const nextTokenIndex = this._tokens.findIndex((t) => !t.tried);

    // If no more tokens to try, user has to enter a new one
    if (nextTokenIndex < 0) {
      return null;
    }

    const nextToken = this._tokens[nextTokenIndex];

    return nextToken;
  }

  _resetTokens () {
    this._tokens = this._tokens.map((token) => ({
      ...token,
      tried: false
    }));
  }

  _sanitiseToken (token) {
    return token.replace(/[^a-zA-Z0-9]/g, '');
  }

  _saveToken (token) {
    store.set('sysuiToken', token);
  }

  /**
   * Promise gets resolved when the node is up
   * and running (it might take some time before
   * the node is actually ready even when the client
   * is connected).
   *
   * We check that the `parity_netChain` RPC calls
   * returns successfully
   */
  _waitUntilNodeReady (_timeleft) {
    // Default timeout to 30 seconds
    const timeleft = Number.isFinite(_timeleft)
      ? _timeleft
      : 30 * 1000;

    // After timeout, just resolve the promise...
    if (timeleft <= 0) {
      console.warn('node is still not ready after 30 seconds...');
      return Promise.resolve(true);
    }

    const start = Date.now();

    return this
      .parity.netChain()
      .then(() => true)
      .catch((error) => {
        if (!error) {
          return true;
        }

        if (error.type !== 'NETWORK_DISABLED') {
          throw error;
        }

        // Timeout between 250ms and 750ms
        const timeout = Math.floor(250 + (500 * Math.random()));

        log.debug('waiting until node is ready', 'retry in', timeout, 'ms');

        // Retry in a few...
        return new Promise((resolve, reject) => {
          window.setTimeout(() => {
            const duration = Date.now() - start;

            this._waitUntilNodeReady(timeleft - duration).then(resolve).catch(reject);
          }, timeout);
        });
      });
  }
}
