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

import React, { Component } from 'react';
import isElectron from 'is-electron';
import { FormattedMessage } from 'react-intl';
import { observer } from 'mobx-react';
import PropTypes from 'prop-types';
import path from 'path';

import builtinDapps from '@parity/shared/lib/config/dappsBuiltin.json';
import viewsDapps from '@parity/shared/lib/config/dappsViews.json';
import DappsStore from '@parity/shared/lib/mobx/dappsStore';
import HistoryStore from '@parity/shared/lib/mobx/historyStore';

import RequestsStore from '../DappRequests/store';
import styles from './dapp.css';

let remote;

if (isElectron()) {
  remote = window.require('electron').remote;
}

const internalDapps = [].concat(viewsDapps, builtinDapps);

@observer
export default class Dapp extends Component {
  static contextTypes = {
    api: PropTypes.object.isRequired
  };

  static propTypes = {
    params: PropTypes.object
  };

  state = {
    app: null,
    loading: true
  };

  store = DappsStore.get(this.context.api);
  historyStore = HistoryStore.get('dapps');
  requestsStore = RequestsStore.get(this.context.api)

  componentWillMount () {
    const { id } = this.props.params;

    if (!internalDapps[id] || !internalDapps[id].skipHistory) {
      this.historyStore.add(id);
    }

    this.loadApp(id);
  }

  componentWillReceiveProps (nextProps) {
    if (nextProps.params.id !== this.props.params.id) {
      this.loadApp(nextProps.params.id);
    }
  }

  handleIframe = () => {
    window.addEventListener('message', this.requestsStore.receiveMessage, false);
  }

  handleWebview = webview => {
    if (!webview) {
      return;
    }

    // Log console.logs from webview
    webview.addEventListener('console-message', e => {
      console.log('[DAPP]', e.message);
    });

    // Reput eventListeners when webview has finished loading dapp
    webview.addEventListener('did-finish-load', () => {
      this.setState({ loading: false });
      // Listen to IPC messages from this webview
      webview.addEventListener('ipc-message', event =>
        this.requestsStore.receiveMessage({
          ...event.args[0],
          source: event.target
        }));
      // Send ping message to tell dapp we're ready to listen to its ipc messages
      webview.send('ping');
    });

    this.onDappLoad();
  };

  loadApp (id) {
    this.setState({ loading: true });

    this.store
      .loadApp(id)
      .then((app) => {
        this.setState({ loading: false, app });
      })
      .catch(() => {
        this.setState({ loading: false });
      });
  }

  renderIframe = (src, hash) => (
    <iframe
      className={ styles.frame }
      frameBorder={ 0 }
      id='dappFrame'
      name={ name }
      onLoad={ this.onDappLoad }
      ref={ this.handleIframe }
      sandbox='allow-forms allow-popups allow-same-origin allow-scripts allow-top-navigation'
      scrolling='auto'
      src={ `${src}${hash}` }
    />
  )

  renderWebview = (src, hash) => (
    <webview
      className={ styles.frame }
      id='dappFrame'
      nodeintegration='true'
      preload={ `file://${path.join(
        remote.getGlobal('dirName'),
        '../.build/inject.js'
      )}` }
      ref={ this.handleWebview }
      src={ `${src}${hash}` }
    />
  );

  render () {
    const { dappsUrl } = this.context.api;
    const { params } = this.props;
    const { app, loading } = this.state;

    if (loading) {
      return null;
    }

    if (!app) {
      return (
        <div className={ styles.full }>
          <div className={ styles.text }>
            <FormattedMessage
              id='dapp.unavailable'
              defaultMessage='The dapp cannot be reached'
            />
          </div>
        </div>
      );
    }

    let src = null;

    switch (app.type) {
      case 'local':
        src = app.localUrl
          ? `${app.localUrl}?appId=${app.id}`
          : `${dappsUrl}/${app.id}/`;
        break;

      case 'network':
        src = `${dappsUrl}/${app.contentHash}/`;
        break;

      default:
        let dapphost = process.env.DAPPS_URL || (
          process.env.NODE_ENV === 'production'
            ? `${dappsUrl}/ui`
            : ''
        );

        if (dapphost === '/') {
          dapphost = '';
        }

        src = window.location.protocol === 'file:'
          ? `dapps/${app.id}/index.html`
          : `${dapphost}/dapps/${app.id}/index.html`;
        break;
    }

    let hash = '';

    if (params.details) {
      hash = `#/${params.details}`;
    }

    return isElectron()
      ? this.renderWebview(src, hash)
      : this.renderIframe(src, hash);
  }

  onDappLoad = () => {
    const frame = document.getElementById('dappFrame');

    frame.style.opacity = 1;
  }
}
