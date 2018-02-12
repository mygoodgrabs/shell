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

const electron = require('electron');
const { app, BrowserWindow, session } = electron;

const path = require('path');
const url = require('url');

const IS_DEV = process.argv.includes('--dev'); // Opens http://127.0.0.1:3000 in --dev mode

let mainWindow;

global.dirName = __dirname; // Will send this to renderers via IPC

function createWindow () {
  mainWindow = new BrowserWindow({
    height: 800,
    width: 1200
  });

  if (IS_DEV) {
    mainWindow.loadURL('http://127.0.0.1:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // TODO Check if file exists?
    mainWindow.loadURL(
      url.format({
        pathname: path.join(__dirname, '../.build/index.html'),
        protocol: 'file:',
        slashes: true
      })
    );
  }

  // WS calls have Origin `file://` by default, which is not trusted.
  // We override Origin header on all WS connections with an authorized one.
  session.defaultSession.webRequest.onBeforeSendHeaders({
    urls: ['ws://*/*', 'wss://*/*']
  }, (details, callback) => {
    details.requestHeaders.Origin = `parity://${mainWindow.id}.wallet.parity`;
    callback({ requestHeaders: details.requestHeaders });
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
