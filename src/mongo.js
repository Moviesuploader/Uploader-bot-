import { MongoClient } from 'mongodb';
import * as adminConfig from './admin-config.js';

let clientPromise = null;
let activeUri = '';

function envUri() {
  return String(process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
}

export function getUri() {
  return adminConfig.getConfig().mongoUri || envUri();
}

export function status() {
  return {
    configured: Boolean(getUri()),
    connected: Boolean(clientPromise && activeUri === getUri()),
  };
}

async function getClient() {
  const uri = getUri();
  if (!uri) throw new Error('MongoDB URI is not configured');
  if (clientPromise && activeUri === uri) return clientPromise;

  activeUri = uri;
  clientPromise = (async () => {
    const client = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      appName: 'uploader-bot',
    });
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('[mongo] connected');
    return client;
  })().catch((err) => {
    clientPromise = null;
    activeUri = '';
    throw err;
  });

  return clientPromise;
}

export async function testConnection() {
  const client = await getClient();
  await client.db('admin').command({ ping: 1 });
  return true;
}

export async function logDownload(data) {
  const client = await getClient();
  await client.db('uploader_bot').collection('downloads').insertOne({
    ...data,
    createdAt: new Date(),
  });
}

export async function close() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {}
  clientPromise = null;
  activeUri = '';
}


export async function getMtprotoConfig() {
  const client = await getClient();
  const doc = await client
    .db('uploader_bot')
    .collection('settings')
    .findOne({ _id: 'mtproto' });
  return doc?.config && typeof doc.config === 'object' ? doc.config : null;
}

export async function saveMtprotoConfig(config) {
  const client = await getClient();
  await client
    .db('uploader_bot')
    .collection('settings')
    .updateOne(
      { _id: 'mtproto' },
      { $set: { config, updatedAt: new Date() } },
      { upsert: true },
    );
  return true;
}

export async function clearMtprotoConfig() {
  const client = await getClient();
  await client.db('uploader_bot').collection('settings').deleteOne({ _id: 'mtproto' });
  return true;
}


export async function saveAdminSettings(settings) {
  // Do not persist Mongo credentials inside the settings document.
  const { mongoUri, ...safeSettings } = settings || {};
  const client = await getClient();
  await client.db('uploader_bot').collection('settings').updateOne(
    { _id: 'admin-config' },
    { $set: { config: safeSettings, updatedAt: new Date() } },
    { upsert: true },
  );
  return true;
}

export async function getAdminSettings() {
  const client = await getClient();
  const doc = await client.db('uploader_bot').collection('settings').findOne({ _id: 'admin-config' });
  return doc?.config && typeof doc.config === 'object' ? doc.config : null;
}
