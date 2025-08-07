const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.urlencoded({ extended: true }));

try {
  const serviceAccount = require('./firebase-service-account.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin initialized successfully');
} catch (error) {
  console.error('Firebase initialization failed:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const activeListeners = new Map();
const firestoreEvents = [];
const collectionSnapshots = new Map();

const config = {
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
  monitoringEnabled: true,
  excludedCollections: ['_internal', '_system'],
  maxEventsInMemory: 1000
};

async function discoverCollections() {
  try {
    console.log('Discovering collections...');
    const collections = await db.listCollections();
    const collectionNames = collections
      .map(col => col.id)
      .filter(name => !config.excludedCollections.includes(name));
    console.log(`Found ${collectionNames.length} collections:`, collectionNames);
    return collectionNames;
  } catch (error) {
    console.error('Error discovering collections:', error);
    return [];
  }
}

async function addCollectionListener(collectionName) {
  if (activeListeners.has(collectionName)) return;

  console.log(`Adding listener for: ${collectionName}`);
  let hasHandledInitialSnapshot = false;

  try {
    const unsubscribe = db.collection(collectionName).onSnapshot(
      snapshot => {
        // Ignore first snapshot
        if (!hasHandledInitialSnapshot) {
          hasHandledInitialSnapshot = true;
          console.log(`Initial snapshot ignored for: ${collectionName}`);
          return;
        }
        handleCollectionSnapshot(collectionName, snapshot);
      },
      error => {
        console.error(`Listener error for ${collectionName}:`, error.message);
        activeListeners.delete(collectionName);
        setTimeout(() => addCollectionListener(collectionName), 5000);
      }
    );

    activeListeners.set(collectionName, unsubscribe);
    console.log(`Listener active for: ${collectionName}`);
  } catch (error) {
    console.error(`Failed to add listener for ${collectionName}:`, error.message);
  }
}

function handleCollectionSnapshot(collectionName, snapshot) {
  if (snapshot.empty) return;

  const changes = snapshot.docChanges();
  if (changes.length === 0) return;

  changes.forEach(change => {
    const doc = change.doc;
    const documentId = doc.id;
    let eventType = 'unknown';
    let oldData = null;
    let newData = null;

    switch (change.type) {
      case 'added':
        eventType = 'create';
        newData = doc.data();
        break;
      case 'modified':
        eventType = 'update';
        newData = doc.data();
        const snapshotKey = `${collectionName}/${documentId}`;
        if (collectionSnapshots.has(snapshotKey)) {
          oldData = collectionSnapshots.get(snapshotKey);
        }
        break;
      case 'removed':
        eventType = 'delete';
        const deleteKey = `${collectionName}/${documentId}`;
        if (collectionSnapshots.has(deleteKey)) {
          oldData = collectionSnapshots.get(deleteKey);
        }
        break;
    }

    const snapshotKey = `${collectionName}/${documentId}`;
    if (change.type !== 'removed') {
      collectionSnapshots.set(snapshotKey, newData);
    } else {
      collectionSnapshots.delete(snapshotKey);
    }

    const event = {
      eventType,
      collection: collectionName,
      documentId,
      timestamp: new Date().toISOString(),
      oldData,
      newData,
      metadata: {
        changeType: change.type,
        source: 'firestore-listener'
      }
    };

    processEvent(event);
  });
}

async function processEvent(event) {
  try {
    firestoreEvents.push(event);
    if (firestoreEvents.length > config.maxEventsInMemory) firestoreEvents.shift();

    console.log(` ${event.eventType.toUpperCase()}: ${event.collection}/${event.documentId}`);

    if (config.n8nWebhookUrl && config.monitoringEnabled) {
      await sendToN8n(event);
    }
  } catch (error) {
    console.error('Error processing event:', error.message);
  }
}

async function sendToN8n(event) {
  try {
    await axios.post(config.n8nWebhookUrl, event, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Firestore-Monitor/1.0'
      },
      timeout: 10000
    });
    console.log(`Sent to n8n: ${event.eventType} ${event.collection}/${event.documentId}`);
  } catch (error) {
    console.error(`n8n webhook error:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

async function startMonitoring() {
  stopAllListeners();
  const collections = await discoverCollections();
  for (const collectionName of collections) {
    await addCollectionListener(collectionName);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(`Monitoring started for ${activeListeners.size} collections`);
  setInterval(async () => {
    const currentCollections = await discoverCollections();
    for (const collectionName of currentCollections) {
      if (!activeListeners.has(collectionName)) {
        console.log(`New collection discovered: ${collectionName}`);
        await addCollectionListener(collectionName);
      }
    }
  }, 30000);
}

function stopAllListeners() {
  for (const [collectionName, unsubscribe] of activeListeners) {
    try {
      unsubscribe();
      console.log(`Stopped: ${collectionName}`);
    } catch (error) {
      console.error(`Error stopping ${collectionName}:`, error.message);
    }
  }
  activeListeners.clear();
  collectionSnapshots.clear();
}

app.listen(PORT, async () => {
  console.log(`\nFirestore Monitor Server Started on port ${PORT}`);
  setTimeout(async () => {
    try {
      await startMonitoring();
    } catch (error) {
      console.error('Failed to auto-start monitoring:', error.message);
    }
  }, 3000);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  stopAllListeners();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  stopAllListeners();
  process.exit(0);
});
