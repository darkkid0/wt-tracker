/**
 * Copyright 2019 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { App, SSLApp, WebSocket, HttpRequest, TemplatedApp } from "uWebSockets.js";
import { Tracker, PeerContext, TrackerError } from "./tracker";
import { StringDecoder } from "string_decoder";

import * as Debug from "debug";

const debugWebSockets = Debug("wt-tracker:uws-tracker");
const debugMessages = Debug("wt-tracker:uws-tracker-messages");
const debugMessagesEnabled = debugMessages.enabled;
const decoder = new StringDecoder();

export class UWebSocketsTracker {
    private _app: TemplatedApp;
    private webSocketsCount: number = 0;

    get app() {
        return this._app;
    }

    get stats() {
        return {
            webSocketsCount: this.webSocketsCount,
        };
    }

    constructor(readonly tracker: Tracker, readonly settings: any = {}) {
        this.settings = {
            server: {
                port: 8000,
                host: "0.0.0.0",
                ...((settings && settings.server) ? settings.server : {}),
            },
            websockets: {
                path: "/",
                maxPayloadLength: 64 * 1024,
                idleTimeout: 240,
                compression: 1,
                ...((settings && settings.websockets) ? settings.websockets : {}),
            },
        };

        this._app = this.settings.server.key_file_name === undefined
                ? App(this.settings.server)
                : SSLApp(this.settings.server);

        this.buildApplication();
    }

    public async run() {
        return new Promise<void>((resolve, reject) => {
            this._app.listen(this.settings.server.host, this.settings.server.port, (token: any) => {
                if (token) {
                    resolve();
                } else {
                    reject(new Error(`failed to listen to ${this.settings.server.host}:${this.settings.server.port}`));
                }
            });
        });
    }

    private buildApplication() {
        this._app
        .ws(this.settings.websockets.path, {
            compression: this.settings.websockets.compression,
            maxPayloadLength: this.settings.websockets.maxPayloadLength,
            idleTimeout: this.settings.websockets.idleTimeout,
            open: (ws: WebSocket, request: HttpRequest) => {
                this.webSocketsCount++;
                debugWebSockets("connected via URL", request.getUrl());
            },
            drain: (ws: WebSocket) => {
                debugWebSockets("drain", ws.getBufferedAmount());
            },
            message: this.onMessage,
            close: this.onClose,
        });
    }

    private onMessage = (ws: WebSocket, message: ArrayBuffer, isBinary: boolean) => {
        debugWebSockets("message of size", message.byteLength);

        let json: any;
        try {
            json = JSON.parse(decoder.end(new Uint8Array(message) as any));
        } catch (e) {
            debugWebSockets("failed to parse JSON message", e);
            ws.close();
            return;
        }

        let peer: PeerContext | undefined = ws.peer;
        if (peer === undefined) {
            peer = createPeer(ws);
            ws.peer = peer;
        }

        if (debugMessagesEnabled) {
            debugMessages("in", peer.id !== undefined ? Buffer.from(peer.id).toString("hex") : "unknown peer", json);
        }

        try {
            this.tracker.processMessage(json, peer);
        } catch (e) {
            if (e instanceof TrackerError) {
                debugWebSockets("failed to process message from the peer:", e);
            } else {
                throw e;
            }
            ws.close();
            return;
        }
    }

    private onClose = (ws: WebSocket, code: number, message: ArrayBuffer) => {
        this.webSocketsCount--;
        const peer: PeerContext | undefined = ws.peer;

        if (peer !== undefined) {
            delete ws.peer;
            this.tracker.disconnectPeer(peer);
        }

        debugWebSockets("closed with code", code);
    }
}

function createPeer(ws: WebSocket): PeerContext {
    return {
        sendMessage: (json: any) => {
            ws.send(JSON.stringify(json), false, false);
            if (debugMessagesEnabled) {
                debugMessages("out", ws.peer.id !== undefined ? Buffer.from(ws.peer.id).toString("hex") : "unknown peer", json);
            }
        },
    };
}
