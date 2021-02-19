import WebSocket from 'isomorphic-ws';
import { backOff } from 'exponential-backoff';

import { Channel, Client } from '..';
import { ServerboundNotification, ClientboundNotification } from './notifications';

import User from '../objects/User';
import { Auth, Users } from '../api/objects';
import { GroupChannel } from '../objects/Channel';

export class WebSocketClient {
    client: Client;
    ws?: WebSocket;

    connected: boolean;
    ready: boolean;

    constructor(client: Client) {
        this.client = client;

        this.connected = false;
        this.ready = false;
    }

    disconnect() {
        this.connected = false;
        this.ready = false;

        if (typeof this.ws !== 'undefined' && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }

    send(notification: ServerboundNotification) {
        if (!this.ws) return;

        let data = JSON.stringify(notification);
        if (this.client.debug) console.debug('[<] PACKET', data);
        this.ws.send(data);
    }

    connect(disallowReconnect?: boolean): Promise<void> {
        this.client.emit('connecting');

        return new Promise((resolve, $reject) => {
            let thrown = false;
            const reject = (err: any) => {
                if (!thrown) {
                    thrown = true;
                    $reject(err);
                }
            };

            this.disconnect();

            if (typeof this.client.configuration === 'undefined') {
                throw new Error("Attempted to open WebSocket without syncing configuration from server.");
            }

            if (typeof this.client.session === 'undefined') {
                throw new Error("Attempted to open WebSocket without valid session.");
            }

            let ws = new WebSocket(this.client.configuration.ws);
            this.ws = ws;

            ws.onopen = () => {
                this.send({ type: 'Authenticate', ...this.client.session as Auth.Session });
            };

            let handle = async (msg: WebSocket.MessageEvent) => {
                let data = msg.data;
                if (typeof data !== 'string') return;

                if (this.client.debug) console.debug('[>] PACKET', data);
                let packet = JSON.parse(data) as ClientboundNotification;
                this.client.emit('packet', packet);
                switch (packet.type) {
                    case 'Error': {
                        reject(packet.error);
                        break;
                    }
                    case 'Authenticated': {
                        disallowReconnect = false;
                        this.client.emit('connected');
                        this.connected = true;
                        break;
                    }
                    case 'Ready': {
                        for (let user of packet.users) {
                            await User.fetch(this.client, user._id, user);
                        }

                        // INFO:
                        // Our user object should be included in this
                        // payload so we can just take it out of the map.
                        let user = this.client.users.get(this.client.session?.user_id as string) as User;
                        user.relationship = Users.Relationship.User;
                        this.client.user = user;

                        for (let channel of packet.channels) {
                            await Channel.fetch(this.client, channel._id, channel);
                        }

                        this.client.emit('ready');
                        this.ready = true;
                        resolve();
                        break;
                    }

                    case 'Message': {
                        if (!this.client.messages.has(packet._id)) {
                            let channel = await Channel.fetch(this.client, packet.channel);
                            let message = await channel.fetchMessage(packet._id, packet);
                            this.client.emit('message', message);
                            channel.patch({
                                last_message: {
                                    _id: packet._id,
                                    author: packet.author,
                                    short: packet.content.substr(0, 24)
                                }
                            }, true);
                        }
                        break;
                    }
                    case 'MessageUpdate': {
                        let message = this.client.messages.get(packet.id);
                        if (message) {
                            message.patch(packet.data, true);
                        }
                        break;
                    }
                    case 'MessageDelete': {
                        let message = this.client.messages.get(packet.id);
                        if (message) {
                            await message.delete(true);
                        }
                        break;
                    }

                    case 'ChannelCreate': {
                        let channel = await Channel.fetch(this.client, packet._id, packet);
                        this.client.emit('channel/create', channel);
                        break;
                    }
                    case 'ChannelUpdate': {
                        let channel = await Channel.fetch(this.client, packet.id);
                        channel.patch(packet.data, true);
                        await channel.$sync();
                        break;
                    }
                    case 'ChannelGroupJoin': {
                        let channel = await Channel.fetch(this.client, packet.id) as GroupChannel;
                        let user = await User.fetch(this.client, packet.user);
                        await channel.$addMember(user);
                        break;
                    }
                    case 'ChannelGroupLeave': {
                        let channel = await Channel.fetch(this.client, packet.id) as GroupChannel;
                        await channel.$removeMember(packet.user);
                        break;
                    }
                    case 'ChannelDelete': {
                        let channel = this.client.channels.get(packet.id);
                        if (channel) {
                            await channel.delete(true);
                        }
                        break;
                    }

                    case 'UserRelationship': {
                        if (packet.status !== Users.Relationship.None || this.client.users.has(packet.user)) {
                            let user = await User.fetch(this.client, packet.user);
                            user.patch({ relationship: packet.status }, true);
                        }
                        break;
                    }
                    case 'UserPresence': {
                        let user = await User.fetch(this.client, packet.id);
                        user.patch({ online: packet.online }, true);
                        break;
                    }
                }
            }
            
            let processing = false;
            let queue: WebSocket.MessageEvent[] = [];
            ws.onmessage = async (data) => {
                queue.push(data);

                if (!processing) {
                    processing = true;
                    while (queue.length > 0) {
                        await handle(queue.shift() as any);
                    }
                    processing = false;
                }
            }

            ws.onerror = (err) => {
                reject(err);
            }

            ws.onclose = () => {
                this.client.emit('dropped');
                this.connected = false;
                this.ready = false;

                if (!disallowReconnect && this.client.autoReconnect) {
                    backOff(() => this.connect(true)).catch(reject);
                }
            };
        });
    }
}
