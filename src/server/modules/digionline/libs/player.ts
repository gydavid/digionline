import { Channel } from '../../../interfaces';
import * as cheerio from 'cheerio';
import { Http } from '../../http';
import config from '../../../../../config/config.json';
import { DB } from '../../db';
import { Context } from '../../inject';
const differenceInSeconds = require('date-fns/differenceInSeconds');

const http: Http[] = config.digionline.users.map(() => new Http());
const db: DB = Context.getContext().get<DB>(DB);

export async function getPlaylist(channel: Channel, quality = 'hq', deviceId) {
  await keepConnection(deviceId, channel);
  const playlists = await getPlayLists(channel, deviceId);
  const stream = await getStream(playlists, quality, deviceId);
  return stream;
}

async function getPlayLists(channel: Channel, deviceId: number, attempt = 0) {
  const lastChannel = db.get(`session.${deviceId}.lastChannel`);
  if (
    lastChannel &&
    lastChannel.id === channel.id &&
    differenceInSeconds(new Date(), new Date(lastChannel.updated)) < 60 * 60 * 5
  ) {
    console.log(`#${getDevice(deviceId).device_name}# Play channel from cache: ${channel.name}`);
    return lastChannel.playlists;
  }
  let hash = db.get(`session.${deviceId}.playerHash`);
  if (!hash) {
    try {
      hash = await getPlayerHash(deviceId, channel);
      db.set(`session.${deviceId}.playerHash`, hash);
    } catch {}
  }
  if (!hash) {
    if (attempt < 5) {
      await login(deviceId);
      return getPlayLists(channel, deviceId, attempt + 1);
    } else {
      throw new Error('Failed player hash parsing! :(');
    }
  }
  const url = `https://online.digi.hu/api/streams/playlist/${channel.id}/${hash}.m3u8`;
  const playlists = await http[deviceId].get(url);
  if (playlists.indexOf('#EXTM3U') < 0) {
    if (attempt < 5) {
      hash = await getPlayerHash(deviceId, channel);
      db.set(`session.${deviceId}.playerHash`, hash);
      return getPlayLists(channel, deviceId, attempt + 1);
    } else {
      throw new Error('Failed playlist parsing! :(');
    }
  }
  db.set(`session.${deviceId}.lastChannel`, { playlists, id: channel.id, updated: new Date() });
  console.log(`#${getDevice(deviceId).device_name}# Play channel: ${channel.name}`);
  return playlists;
}

async function getPlayerHash(deviceId: number, channel: Channel, attempt = 0): Promise<string> {
  console.log(`#${getDevice(deviceId).device_name}# Get playlist hash: ${channel.name}`);
  try {
    const playerHtml = await http[deviceId].get(`https://digionline.hu/player/${channel.id}`);
    const urlMatch = playerHtml.match(/http(.*?).m3u8/g);
    const url = urlMatch[0];
    const hash = url.match(/[a-f0-9]{32}/i)[0];
    return hash;
  } catch {
    if (attempt < 5) {
      await login(deviceId);
      return getPlayerHash(deviceId, channel, attempt + 1);
    }
  }
}

async function keepConnection(deviceId: number, channel: Channel, attempt = 0) {
  try {
    const lastRefresh = db.get(`session.${deviceId}.lastRefresh`);
    if (lastRefresh && differenceInSeconds(new Date(), new Date(lastRefresh)) < 5 * 60) return true;
    console.log(`#${getDevice(deviceId).device_name}# Keep connection`);
    const response = await http[deviceId].get(`https://digionline.hu/refresh?id=${channel.id}`, {
      Referer: `https://digionline.hu/player/${channel.id}`,
      'X-Requested-With': 'XMLHttpRequest',
    });
    const success = !JSON.parse(response).error;
    if(!success && attempt < 5) {
      await login(deviceId);
      return keepConnection(deviceId, channel, attempt + 1);
    }
    db.set(`session.${deviceId}.lastRefresh`, new Date());
    return success;
  } catch {
    if (attempt < 5) {
      await login(deviceId);
      return keepConnection(deviceId, channel, attempt + 1);
    }
  }
}

async function getStream(playlists, quality, deviceId) {
  let streamUrl = playlists.trim().match(new RegExp(`https:(.*q=${quality}.*)`, 'g'));
  if (!streamUrl) streamUrl = playlists.trim().match(new RegExp(`https:(.*q=.*)$`, 'g'));
  const timestamp = Math.floor(Date.now() / 1000);
  let url = streamUrl[0];
  return await http[deviceId].get(url);
}

async function login(deviceId: number) {
  console.log(`#${getDevice(deviceId).device_name}# Login to DigiOnline...`);
  const response = await http[deviceId].get('https://digionline.hu/login');

  const $ = cheerio.load(response);
  const token = $('[name="_token"]').val();

  if (!token) {
    throw new Error('missing token');
  }

  await http[deviceId].post('https://digionline.hu/login', {
    _token: token,
    accept: '1',
    email: getDevice(deviceId).email,
    password: getDevice(deviceId).password,
  });

  if (isLoggedIn(deviceId)) {
    db.set(`session.${deviceId}`, { lastRefresh: new Date() });
    console.log(`#${getDevice(deviceId).device_name}# Login Success!`);
  } else {
    throw new Error('Login Failed :(');
  }
}

async function isLoggedIn(deviceId: number) {
  const response = await http[deviceId].get('https://digionline.hu/');

  return response.indexOf('"in-user"') > -1 ? true : false;
}

export function getDevice(devieId: number) {
  return config.digionline.users[devieId];
}
