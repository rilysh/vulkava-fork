import { EventEmitter } from 'node:events';

import Node, { NodeState } from './Node';
import Track from './Track';
import { ConnectionState, Player } from '..';
import Spotify from './sources/Spotify';
import Deezer from './sources/Deezer';

import type {
  IncomingDiscordPayload,
  OutgoingDiscordPayload,
  EventListeners,
  LoadTracksResult,
  PlayerOptions,
  SearchResult,
  SEARCH_SOURCE,
  VoiceServerUpdatePayload,
  VoiceStateUpdatePayload,
  VulkavaOptions,
  TrackInfo,
  ITrack,
  PlaylistInfo
} from './@types';
import AppleMusic from './sources/AppleMusic';
import Cache from './Cache';

export interface Vulkava {
  once: EventListeners<this>;
  on: EventListeners<this>;
}

/**
 * Represents the main Vulkava client.
 * @extends EventEmitter
 * @prop {Array<Node>} nodes - The lavalink nodes array
 * @prop {String} clientId - The bot id
 * @prop {Map<String, Player>} players - The players map
 */
export class Vulkava extends EventEmitter {
  public clientId: string;
  public nodes: Node[];
  public cache: Cache<{ q: string, v: LoadTracksResult }>;
  private readonly defaultSearchSource: SEARCH_SOURCE;
  public readonly unresolvedSearchSource: SEARCH_SOURCE;
  declare private readonly appleMusic?: AppleMusic;
  declare private readonly deezer?: Deezer;
  declare private readonly spotify?: Spotify;

  public readonly sendWS: (guildId: string, payload: OutgoingDiscordPayload) => void;

  static readonly APPLE_MUSIC_REGEX = /^(?:https?:\/\/|)?(?:music\.)?apple\.com\/([a-z]{2})\/(album|playlist|artist|music-video)\/[^/]+\/([^/?]+)(?:\?i=(\d+))?/;
  static readonly SPOTIFY_REGEX = /^(?:https:\/\/open\.spotify\.com\/(?:user\/[A-Za-z0-9]+\/)?|spotify:)(album|playlist|track)(?:[/:])([A-Za-z0-9]+).*$/;
  static readonly DEEZER_REGEX = /^(?:https?:\/\/|)?(?:www\.)?deezer\.com\/(?:\w{2}\/)?(track|album|playlist)\/(\d+)/;

  // guildId <-> Player
  public players: Map<string, Player>;

  private lastNodeSorting: number;

  static checkOptions(options: VulkavaOptions) {
    if (typeof options !== 'object') {
      throw new TypeError('VulkavaOptions must be an object');
    }

    if (!options.nodes) {
      throw new TypeError('VulkavaOptions must contain a nodes property');
    }

    if (!Array.isArray(options.nodes)) {
      throw new TypeError('VulkavaOptions.nodes must be an array');
    }

    if (options.nodes.length === 0) {
      throw new TypeError('VulkavaOptions.nodes must contain at least one node');
    }

    if (!options.sendWS || typeof options.sendWS !== 'function') {
      throw new TypeError('VulkavaOptions.sendWS must be a function');
    }

    if (options.disabledSources && typeof options.disabledSources !== 'object' && !Array.isArray(options.disabledSources)) {
      throw new TypeError('VulkavaOptions.disabledSources must be an array');
    }
  }

  /**
   * Create a new Vulkava instance
   * @param {Object} options - The Vulkava options
   * @param {Array<Object>} options.nodes - The lavalink nodes array
   * @param {String} [options.nodes[].id] - The lavalink node identifier
   * @param {String} options.nodes[].hostname - The lavalink node hostname
   * @param {Number} options.nodes[].port - The lavalink node port
   * @param {String} [options.nodes[].password] - The lavalink node password
   * @param {Boolean} [options.nodes[].secure] - Whether the lavalink node uses TLS/SSL or not
   * @param {Boolean} [options.nodes[].followRedirects] - Whether to follow redirects or not (default is false)
   * @param {String} [options.nodes[].region] - The lavalink node region
   * @param {String} [options.nodes[].resumeKey] - The resume key
   * @param {Number} [options.nodes[].resumeTimeout] - The resume timeout, in seconds
   * @param {Number} [options.nodes[].maxRetryAttempts] - The max number of retry attempts
   * @param {Number} [options.nodes[].retryAttemptsInterval] - The interval between retry attempts
   * @param {String} [options.defaultSearchSource] - The default search source
   * @param {String} [options.unresolvedSearchSource] - The unresolved search source
   * @param {Object} [options.spotify] - The spotify credential options
   * @param {String} [options.spotify.clientId] - The spotify client id
   * @param {String} [options.spotify.clientSecret] - The spotify client secret
   * @param {String} [options.spotify.market] - The spotify market
   * @param {Array<String>} options.disabledSources - Disables, apple music, deezer or spotify
   * @param {Function} options.sendWS - The function to send websocket messages to the main gateway
   */
  constructor(options: VulkavaOptions) {
    super();

    Vulkava.checkOptions(options);

    this.nodes = [];
    this.defaultSearchSource = options.defaultSearchSource ?? 'youtube';
    this.unresolvedSearchSource = options.unresolvedSearchSource ?? 'youtubemusic';

    if (options.disabledSources) {
      if (!options.disabledSources.includes('APPLE_MUSIC')) this.appleMusic = new AppleMusic(this);
      if (!options.disabledSources.includes('DEEZER')) this.deezer = new Deezer(this);
      if (!options.disabledSources.includes('SPOTIFY')) this.spotify = new Spotify(this, options.spotify?.clientId, options.spotify?.clientSecret, options.spotify?.market);
    } else {
      this.appleMusic = new AppleMusic(this);
      this.deezer = new Deezer(this);
      this.spotify = new Spotify(this, options.spotify?.clientId, options.spotify?.clientSecret, options.spotify?.market);
    }

    this.sendWS = options.sendWS;

    this.players = new Map();

    for (const nodeOp of options.nodes) {
      const node = new Node(this, nodeOp);
      this.nodes.push(node);
    }

    this.lastNodeSorting = 0;
  }

  public get bestNode(): Node {
    if (Date.now() < (this.lastNodeSorting + 30000)) {
      if (this.nodes[0].state === NodeState.CONNECTED) {
        return this.nodes[0];
      }

      this.lastNodeSorting = 0;
      return this.bestNode;
    }

    const node = this.nodes.sort((a, b) => a.totalPenalties - b.totalPenalties)[0];

    if (!node || node.state !== NodeState.CONNECTED) {
      throw new Error('No connected nodes!');
    }

    return node;
  }

  /**
   * Decodes a track by its base64 string
   * @param {String} encodedTrack - The base64 encoded track
   * @returns {Promise<Track>}
   */
  public async decodeTrack(encodedTrack: string): Promise<Track> {
    const node = this.bestNode;

    const trackInfo = await node.request<TrackInfo>('GET', `decodetrack?track=${encodedTrack}`);

    return new Track({ track: encodedTrack, info: { ...trackInfo } });
  }

  /**
   * Decodes multiple tracks by their base64 string
   * @param {String[]} encodedTracks - The base64 encoded tracks
   * @returns {Promise<Track[]>}
   */
  public async decodeTracks(encodedTracks: string[]): Promise<Track[]> {
    const node = this.bestNode;

    const res = await node.request<ITrack[]>('POST', 'decodetracks', encodedTracks);

    return res.map(it => new Track(it));
  }

  /**
   * Creates a new player or returns an existing one
   * @param {Object} options - The player options
   * @param {String} options.guildId - The guild id that player belongs to
   * @param {String} options.voiceChannelId - The voice channel id
   * @param {String} [options.textChannelId] - The text channel id
   * @param {Boolean} [options.selfDeaf=false] - Whether the bot joins the voice channel deafened or not
   * @param {Boolean} [options.selfMute=false] - Whether the bot joins the voice channel muted or not
   * @returns {Player}
   */
  public createPlayer(options: PlayerOptions): Player {
    let player = this.players.get(options.guildId);

    if (player) {
      return player;
    }

    player = new Player(this, options);
    this.players.set(options.guildId, player);

    return player;
  }

  private async loadFromAppleMusic(query: string): Promise<SearchResult | null> {
    if (!this.appleMusic) return null;

    const appleMusicMatch = query.match(Vulkava.APPLE_MUSIC_REGEX);
    if (!appleMusicMatch) return null;

    let list;
    const storefront = appleMusicMatch[1];

    switch (appleMusicMatch[2]) {
      case 'music-video':
        return {
          loadType: 'TRACK_LOADED',
          playlistInfo: {} as PlaylistInfo,
          tracks: [await this.appleMusic.getMusicVideo(appleMusicMatch[3], storefront)],
        };
      case 'album':
        if (appleMusicMatch[4]) {
          return {
            loadType: 'TRACK_LOADED',
            playlistInfo: {} as PlaylistInfo,
            tracks: [await this.appleMusic.getTrack(appleMusicMatch[4], storefront)],
          };
        } else {
          list = await this.appleMusic.getAlbum(appleMusicMatch[3], storefront);
          return {
            loadType: 'PLAYLIST_LOADED',
            playlistInfo: {
              name: list.title,
              duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
              selectedTrack: 0
            },
            tracks: list.tracks,
          };
        }
      case 'playlist':
        list = await this.appleMusic.getPlaylist(appleMusicMatch[3], storefront);

        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks
        };
      case 'artist':
        list = await this.appleMusic.getArtistTopTracks(appleMusicMatch[3], storefront);

        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks
        };
    }

    return null;
  }

  private async loadFromDeezer(query: string): Promise<SearchResult | null> {
    if (!this.deezer) return null;

    const deezerMatch = query.match(Vulkava.DEEZER_REGEX);
    if (!deezerMatch) return null;

    let list;

    switch (deezerMatch[1]) {
      case 'track':
        return {
          loadType: 'TRACK_LOADED',
          playlistInfo: {} as PlaylistInfo,
          tracks: [await this.deezer.getTrack(deezerMatch[2])],
        };
      case 'album':
        list = await this.deezer.getAlbum(deezerMatch[2]);
        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks,
        };
      case 'playlist':
        list = await this.deezer.getPlaylist(deezerMatch[2]);

        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks
        };
    }

    return null;
  }

  private async loadFromSpotify(query: string): Promise<SearchResult | null> {
    if (!this.spotify) return null;

    const spotifyMatch = query.match(Vulkava.SPOTIFY_REGEX);
    if (!spotifyMatch) return null;

    let list;

    switch (spotifyMatch[1]) {
      case 'track':
        return {
          loadType: 'TRACK_LOADED',
          playlistInfo: {} as PlaylistInfo,
          tracks: [await this.spotify.getTrack(spotifyMatch[2])],
        };
      case 'album':
        list = await this.spotify.getAlbum(spotifyMatch[2]);
        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks,
        };
      case 'playlist':
        list = await this.spotify.getPlaylist(spotifyMatch[2]);

        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks
        };
      case 'artist':
        list = await this.spotify.getArtistTopTracks(spotifyMatch[2]);

        return {
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: list.title,
            duration: list.tracks.reduce((acc, curr) => acc + curr.duration, 0),
            selectedTrack: 0
          },
          tracks: list.tracks
        };
    }

    return null;
  }

  /**
   *
   * @param {String} query - The query to search for
   * @param {('youtube' | 'youtubemusic' | 'soundcloud' | 'odysee' | 'yandex')} [source=youtube] - The search source
   * @returns {Promise<SearchResult>}
   */
  public async search(query: string, source: SEARCH_SOURCE = this.defaultSearchSource): Promise<SearchResult> {
    const node = this.bestNode;

    const extSourceResult = await this.loadFromAppleMusic(query) ?? await this.loadFromDeezer(query) ?? await this.loadFromSpotify(query);

    if (extSourceResult) return extSourceResult;

    const sourceMap = {
      youtube: 'ytsearch:',
      youtubemusic: 'ytmsearch:',
      soundcloud: 'scsearch:',
      odysee: 'odsearch:',
      yandex: 'ymsearch:'
    };

    if (!query.startsWith('https://') && !query.startsWith('http://')) {
      query = `${sourceMap[source] || 'ytsearch:'}${query}`;
    }

    let res: LoadTracksResult | undefined;
    if (this.cache.each.length === 0) {
      res = await node.request<LoadTracksResult>('GET', `loadtracks?identifier=${encodeURIComponent(query)}`);
      this.cache.add({ q: query, v: res });
    } else {
      this.cache.each.map((x) => {
        if (x.q === query) {
          res = x.v;
        }
      });
      if (!res) {
        res = await node.request<LoadTracksResult>('GET', `loadtracks?identifier=${encodeURIComponent(query)}`);
        this.cache.add({ q: query, v: res });
      }
    }

    if (res.loadType === 'LOAD_FAILED' || res?.loadType === 'NO_MATCHES') {
      return res as unknown as SearchResult;
    } else {
      const tracks = res?.tracks.map((t: ITrack) => new Track(t));
      if (res.loadType === 'PLAYLIST_LOADED') {
        res.playlistInfo.duration = tracks.reduce((acc: number, cur: { duration: number }) => acc + cur.duration, 0);
      }

      return {
        ...res,
        tracks
      };
    }
  }

  /**
   * Connects to all lavalink nodes
   * @param {String} clientId - The client (BOT) id
   */
  public start(clientId: string) {
    if (typeof clientId !== 'string') {
      throw new TypeError('clientId must be a string');
    }

    this.clientId = clientId;

    for (const node of this.nodes) {
      node.connect();
    }
    this.cache = new Cache();
  }

  /**
   * Handles voice state & voice server update packets
   * @param payload - The voice packet
   */
  public handleVoiceUpdate(payload: IncomingDiscordPayload) {
    if (payload.op !== 0 || !(payload.d as Record<string, unknown>).guild_id) return;

    const player = this.players.get((payload.d as Record<string, unknown>).guild_id as string);

    if (!player) return;

    if (payload.t === 'VOICE_STATE_UPDATE') {
      const packet = payload as VoiceStateUpdatePayload;

      if (packet.d.user_id !== this.clientId) return;

      player.voiceState.sessionId = packet.d.session_id;

      if (packet.d.channel_id) {
        player.voiceChannelId = packet.d.channel_id;
      }

      if (player.voiceState.event) {
        player.sendVoiceUpdate();
      }
    } else if (payload.t === 'VOICE_SERVER_UPDATE') {
      const packet = payload as VoiceServerUpdatePayload;

      // Sometimes discord sends a partial voice server update packet, with null endpoint
      // Just wait for a new one I guess ?
      if (!packet.d.endpoint) {
        return;
      }

      player.voiceState.event = {
        ...packet.d
      };

      // A node should be assigned to the player on Player#connect()
      if (player.node === null) {
        player.state = ConnectionState.DISCONNECTED;
        throw new Error('Assertion failed. The Player does not have a node.');
      }

      if (['us', 'brazil', 'buenos-aires'].some(loc => player.voiceState.event.endpoint.startsWith(loc))) {
        if (player.node.options.region && player.node.options.region !== 'USA') {
          const usaNodes = this.nodes.filter(node => node.options.region === 'USA' && node.state === NodeState.CONNECTED);

          if (usaNodes.length) {
            // Nodes are already sorted by penalties
            player.moveNode(usaNodes[0]);
            return;
          }
        }
      } else if (player.node.options.region && player.node.options.region !== 'EU') {
        const europeNodes = this.nodes.filter(node => node.options.region === 'EU' && node.state === NodeState.CONNECTED);

        if (europeNodes.length) {
          // Nodes are already sorted by penalties
          player.moveNode(europeNodes[0]);
          return;
        }
      }

      if (player.voiceState.sessionId) {
        player.sendVoiceUpdate();
      }
    }
  }
}