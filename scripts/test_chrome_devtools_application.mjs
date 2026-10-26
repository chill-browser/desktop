/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const port = Number(process.argv[2] ?? 9230);
const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
const pending = new Map();
const events = [];
let nextId = 1;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id) {
    events.push(message);
    return;
  }
  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  clearTimeout(request.timeout);
  pending.delete(message.id);
  if (message.error) {
    request.reject(new Error(message.error.message));
  } else {
    request.resolve(message.result);
  }
});

socket.addEventListener("error", event => {
  console.error("WebSocket error", event);
  process.exitCode = 1;
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await send("Page.navigate", { url: "http://127.0.0.1:8081/idb.html?app-test=1" });
  await new Promise(resolve => setTimeout(resolve, 1200));

  const { storageKey } = await send("Storage.getStorageKey");
  assert(storageKey === "http://127.0.0.1:8081", `unexpected key ${storageKey}`);
  const storageBucket = { storageKey };
  await send("Storage.setStorageBucketTracking", {
    storageKey,
    enable: true,
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(
    events.some(
      event =>
        event.method === "Storage.storageBucketCreatedOrUpdated" &&
        event.params?.bucketInfo?.bucket?.storageKey === storageKey
    ),
    "missing storage bucket event"
  );

  await send("IndexedDB.enable");
  const names = await send("IndexedDB.requestDatabaseNames", {
    storageBucket,
  });
  assert(
    names.databaseNames.includes("chill-db"),
    `missing database: ${JSON.stringify(names.databaseNames)}`
  );

  const database = await send("IndexedDB.requestDatabase", {
    storageBucket,
    databaseName: "chill-db",
  });
  const objectStore = database.databaseWithObjectStores?.objectStores?.find(
    store => store.name === "items"
  );
  assert(objectStore, "missing object store");
  assert(
    objectStore.indexes.some(index => index.name === "byName"),
    "missing index"
  );

  const data = await send("IndexedDB.requestData", {
    storageBucket,
    databaseName: "chill-db",
    objectStoreName: "items",
    skipCount: 0,
    pageSize: 50,
  });
  assert(data.objectStoreDataEntries.length === 2, "unexpected IDB row count");

  await send("ServiceWorkerCache.enable");
  const caches = await send("CacheStorage.requestCacheNames", {
    storageBucket,
  });
  const cache = caches.caches.find(item => item.cacheName === "chill-cache");
  assert(cache, `missing cache: ${JSON.stringify(caches.caches)}`);

  const entries = await send("CacheStorage.requestEntries", {
    cacheId: cache.cacheId,
    skipCount: 0,
    pageSize: 50,
  });
  assert(
    entries.cacheDataEntries.some(entry =>
      entry.requestURL.endsWith("/data.json")
    ),
    "missing cache entry"
  );

  console.log(
    JSON.stringify(
      {
        storageKey,
        databases: names.databaseNames,
        objectStores: database.databaseWithObjectStores.objectStores.map(
          store => store.name
        ),
        entries: data.objectStoreDataEntries.length,
        caches: caches.caches.map(item => item.cacheName),
        cacheEntries: entries.cacheDataEntries.map(entry => entry.requestURL),
      },
      null,
      2
    )
  );
} finally {
  socket.close();
}
