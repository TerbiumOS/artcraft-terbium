/*
 * ArtCraft <-> Terbium Files bridge
 *
 * Drop this file into the injected build for ArtCraft apps.
 *
 * Responsibilities:
 *   - Exposes window.artcraftTfs
 *   - Replaces native <input type=file> dialogs with Terbium FileBrowser
 *   - Reads selected files from Terbium FS and dispatches artcraft:tfs-open
 *   - Tracks Blob URLs / exported Blobs
 *   - Provides saveFile / chooseSave / saveLastExport
 *   - Handles Ctrl+S / Ctrl+Shift+S
 *   - Persists localStorage into Terbium FS
 *
 * The app-specific adapter only needs to consume:
 *   window.artcraftTfs.openPicker()
 *   window.artcraftTfs.saveLastExport()
 *   window.artcraft:tfs-open
 *
 * Expected host:
 *   window.parent.tb.fs.promises
 *   window.parent.tb.dialog.FileBrowser
 *   window.parent.tb.dialog.SaveFile
 */

(() => {
  "use strict";

  if (window.__artcraftTfsBridgeInstalled) return;
  window.__artcraftTfsBridgeInstalled = true;

  const APP = window.__ARTCRAFT_APP__ || "vectorcraft";
  const BRIDGE_VERSION = "2.0.0";

  const log = (...args) => {
    if (window.__ARTCRAFT_DEBUG__) {
      console.debug("[artcraftTfs]", ...args);
    }
  };

  const warn = (...args) => console.warn("[artcraftTfs]", ...args);

  const describeError = error => {
    if (error instanceof Error) {
      return error.stack || error.message || String(error);
    }
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error, Object.getOwnPropertyNames(error), 2);
    } catch {
      return String(error);
    }
  };

  const alert = (title, message) => {
    const readable = describeError(message);
    try {
      window.parent?.tb?.dialog?.Alert?.({
        title,
        message: readable
      });
    } catch {
      console.error(`[${title}]`, readable);
    }
  };

  /*
   * --------------------------------------------------------------------------
   * Terbium host access
   * --------------------------------------------------------------------------
   */

  function host() {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent;
      }
    } catch {}

    return window;
  }

  function fs() {
    try {
      return host()?.tb?.fs?.promises || null;
    } catch {
      return null;
    }
  }

  function dialog() {
    try {
      return host()?.tb?.dialog || null;
    } catch {
      return null;
    }
  }

  function currentUser() {
    try {
      const parent = host();
      const user = parent?.sessionStorage?.getItem("currAcc");

      if (
        user &&
        !/[\/\\]/.test(user) &&
        user !== "." &&
        user !== ".."
      ) {
        return user;
      }
    } catch {}

    return null;
  }

  function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength
      );
    }

    if (value instanceof Blob) {
      return value;
    }

    if (typeof value === "string") {
      return new TextEncoder().encode(value);
    }

    throw new TypeError("Unsupported file data");
  }

  function basename(path, fallback = "document") {
    const name = String(path || "")
      .split(/[\/\\]/)
      .filter(Boolean)
      .pop();

    return name || fallback;
  }

  function homePath() {
    const user = currentUser();
    if (!user) {
      throw new Error("Terbium user profile is unavailable");
    }

    return `/home/${user}`;
  }

  function documentsPath() {
    return `${homePath()}/documents`;
  }

  /*
   * --------------------------------------------------------------------------
   * Open files
   * --------------------------------------------------------------------------
   */

  async function dispatchOpen(name, bytes, path = null) {
    const normalized = normalizeBytes(bytes);
    const byteView = normalized instanceof Blob
      ? new Uint8Array(await normalized.arrayBuffer())
      : normalized;

    // Give consumers several common representations. `bytes` remains a
    // Uint8Array for compatibility with the original adapter.
    const payload = {
      name,
      path,
      bytes: byteView,
      data: byteView,
      arrayBuffer: byteView.buffer.slice(
        byteView.byteOffset,
        byteView.byteOffset + byteView.byteLength
      ),
      file: new File([byteView], name, {
        type: mimeTypeForName(name)
      })
    };

    const eventName =
      APP === "pdfcraft"
        ? "pdfcraft:tfs-open"
        : "artcraft:tfs-open";

    window.dispatchEvent(new CustomEvent(eventName, { detail: payload }));

    log("Dispatched open event:", eventName, name, path, {
      byteLength: byteView.byteLength,
      mimeType: payload.file.type
    });

    return payload;
  }

  function mimeTypeForName(name) {
    const extension = basename(name, "").split(".").pop()?.toLowerCase();
    const types = {
      svg: "image/svg+xml",
      svgz: "image/svg+xml",
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
      tif: "image/tiff",
      tiff: "image/tiff",
      json: "application/json",
      txt: "text/plain"
    };
    return types[extension] || "application/octet-stream";
  }

  async function populateFileInput(input, result) {
    if (!input || input.type !== "file") return false;

    try {
      const file = result.file || new File(
        [result.bytes],
        result.name,
        { type: mimeTypeForName(result.name) }
      );
      const transfer = new DataTransfer();
      transfer.items.add(file);

      // Assigning files is supported by Chromium-based browsers used by Terbium.
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (error) {
      warn("Could not populate the app's file input:", error);
      return false;
    }
  }

  async function readFile(path) {
    const filesystem = fs();

    if (!filesystem) {
      throw new Error("Terbium File System is unavailable");
    }

    const stat = await filesystem.stat(path);

    if (!stat || stat.isDirectory?.()) {
      throw new Error("Select a file, not a folder");
    }

    const raw = await filesystem.readFile(path, "arraybuffer");
    const bytes = normalizeBytes(raw);
    const name = basename(path);

    await dispatchOpen(name, bytes, path);

    return {
      path,
      name,
      bytes
    };
  }

  async function openSelectedFile(path) {
    if (typeof path !== "string" || !path) {
      throw new Error("No file was selected");
    }

    return readFile(path);
  }

  function openPicker(options = {}) {
    const user = currentUser();
    const dialogs = dialog();

    if (!user || !dialogs?.FileBrowser) {
      throw new Error("Terbium FileBrowser is unavailable");
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };

      try {
        dialogs.FileBrowser({
          title: options.title || "Open from Terbium Files",
          //filter: options.filter || "*.*",

          // Terbium historically spells this option "defualtDir".
          // Keep that spelling for compatibility.
          defualtDir:
            options.defaultDir ||
            options.defualtDir ||
            `${documentsPath()}`,

          // Also provide the correctly spelled form for newer hosts.
          defaultDir:
            options.defaultDir ||
            options.defualtDir ||
            `${documentsPath()}`,

          local: true,

          onOk: path => {
            void openSelectedFile(path)
              .then(result => finish(resolve, result))
              .catch(error => finish(reject, error));
          },

          onCancel: () => {
            finish(reject, new Error("Open canceled"));
          }
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /*
   * --------------------------------------------------------------------------
   * Save files
   * --------------------------------------------------------------------------
   */

  async function ensureDirectory(path) {
    const filesystem = fs();

    if (!filesystem) {
      throw new Error("Terbium File System is unavailable");
    }

    try {
      await filesystem.mkdir(path);
      return;
    } catch {}

    const stat = await filesystem
      .stat(path)
      .catch(() => null);

    if (!stat?.isDirectory?.()) {
      throw new Error(`Unable to create directory: ${path}`);
    }
  }

  async function writeFile(path, data) {
    const filesystem = fs();

    if (!filesystem) {
      throw new Error("Terbium File System is unavailable");
    }

    let bytes;
    if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      const normalized = normalizeBytes(data);
      bytes = normalized instanceof ArrayBuffer
        ? new Uint8Array(normalized)
        : normalized;
    }

    // Pass an exact, standalone ArrayBuffer; a typed-array's backing buffer
    // can contain unrelated bytes outside its byteOffset/byteLength.
    const exactBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );

    if (exactBuffer.byteLength === 0 && bytes.byteLength !== 0) {
      throw new Error("Export data could not be converted to bytes");
    }

    await filesystem.writeFile(path, exactBuffer, "arraybuffer");

    const stat = await filesystem.stat(path).catch(() => null);
    if (!stat || stat.size !== exactBuffer.byteLength) {
      throw new Error(`TFS write verification failed for ${path}: expected ${exactBuffer.byteLength} bytes, found ${stat?.size ?? 0}`);
    }

    log("Wrote file:", path, {
      bytes: exactBuffer.byteLength
    });
  }

  async function saveFile(
    name,
    bytes,
    saveAs = false,
    suggestedPath = null
  ) {
    const user = currentUser();
    const filesystem = fs();

    if (!user || !filesystem) {
      throw new Error("Terbium File System is unavailable");
    }

    const safeName = basename(name, "document");
    const suggested =
      suggestedPath ||
      `${documentsPath()}/${safeName}`;

    const saveDirect = async destination => {
      const path = String(destination || suggested);
      const home = homePath();

      if (
        path !== home &&
        !path.startsWith(`${home}/`)
      ) {
        throw new Error(
          "Files must be saved inside your Terbium home folder"
        );
      }

      const slash = path.lastIndexOf("/");
      const parent =
        slash > 0 ? path.slice(0, slash) : home;

      await ensureDirectory(parent);
      await writeFile(path, bytes);

      log("Saved:", path);
      return path;
    };

    /*
     * Normal save goes directly to the suggested path.
     * Save As opens Terbium's SaveFile dialog.
     */
    if (!saveAs) {
      return saveDirect(suggested);
    }

    const dialogs = dialog();

    if (!dialogs?.SaveFile) {
      throw new Error("Terbium SaveFile dialog is unavailable");
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };

      try {
        dialogs.SaveFile({
          title: "Save to Terbium Files",

          defualtDir:
            suggested.slice(0, suggested.lastIndexOf("/")) ||
            documentsPath(),

          defaultDir:
            suggested.slice(0, suggested.lastIndexOf("/")) ||
            documentsPath(),

          filename: safeName,
          local: true,

          onOk: path => {
            void saveDirect(path)
              .then(result => finish(resolve, result))
              .catch(error => finish(reject, error));
          },

          onCancel: () => {
            finish(reject, new Error("Save canceled"));
          }
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function chooseSave(name, bytes, saveAs = true) {
    const safeName = basename(name, "export");

    return saveFile(
      safeName,
      bytes,
      saveAs,
      `${documentsPath()}/${safeName}`
    );
  }

  /*
   * --------------------------------------------------------------------------
   * Blob / export tracking
   * --------------------------------------------------------------------------
   */

  const blobStore = window.__artcraftBlobStore instanceof Map
    ? window.__artcraftBlobStore
    : new Map();

  window.__artcraftBlobStore = blobStore;

  function rememberBlob(blob, url) {
    if (!(blob instanceof Blob)) return url;

    blobStore.set(url, blob);

    window.__artcraftLastBlobUrl = url;
    window.__artcraftSaveBlob = blob;

    /*
     * Keep both names for compatibility with older adapters.
     */
    if (!(window.__artcraftBlobUrlToBlob instanceof Map)) {
      window.__artcraftBlobUrlToBlob = new Map();
    }

    window.__artcraftBlobUrlToBlob.set(url, blob);

    log("Tracked Blob URL:", url, blob.type, blob.size);

    return url;
  }

  function installBlobTracking() {
    if (window.__artcraftBlobTrackingInstalled) return;
    window.__artcraftBlobTrackingInstalled = true;

    const NativeURL = window.URL;

    if (!NativeURL?.createObjectURL) {
      warn("URL.createObjectURL is unavailable");
      return;
    }

    /*
     * Don't replace URL itself if another injected script already replaced it.
     * Patch createObjectURL on the existing constructor where possible.
     */
    try {
      const nativeCreateObjectURL =
        NativeURL.createObjectURL.bind(NativeURL);

      const wrapped = function(blob) {
        const url = nativeCreateObjectURL(blob);
        return rememberBlob(blob, url);
      };

      Object.defineProperty(NativeURL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: wrapped
      });

      /*
       * revokeObjectURL is deliberately not used to delete our Blob record.
       * Some apps revoke a URL immediately after assigning it to an anchor,
       * while the resulting Blob is still exactly what we need for Ctrl+S.
       */
    } catch (error) {
      /*
       * Some environments expose URL as non-configurable. Fall back to a
       * Proxy so the integration still works.
       */
      try {
        window.URL = new Proxy(NativeURL, {
          get(target, property) {
            if (property === "createObjectURL") {
              return blob => {
                const url = NativeURL.createObjectURL(blob);
                return rememberBlob(blob, url);
              };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function"
              ? value.bind(target)
              : value;
          }
        });
      } catch (proxyError) {
        warn(
          "Could not install Blob URL tracking:",
          error,
          proxyError
        );
      }
    }
  }

  function currentExportBlob() {
    if (window.__artcraftSaveBlob instanceof Blob) {
      return window.__artcraftSaveBlob;
    }

    const url = window.__artcraftLastBlobUrl;

    if (url && blobStore.has(url)) {
      return blobStore.get(url);
    }

    if (
      url &&
      window.__artcraftBlobUrlToBlob instanceof Map &&
      window.__artcraftBlobUrlToBlob.has(url)
    ) {
      return window.__artcraftBlobUrlToBlob.get(url);
    }

    return null;
  }

  async function saveLastExport({ saveAs = false } = {}) {
    const blob = currentExportBlob();

    if (!blob) {
      throw new Error(
        "No exported file is available yet. Use the app's Export command first."
      );
    }

    const name =
      window.__artcraftCurrentExportName ||
      `${APP}-export`;

    return saveFile(name, blob, saveAs);
  }

  /*
   * Compatibility alias used by older adapters.
   */
  async function saveLastBlob({ saveAs = false } = {}) {
    return saveLastExport({ saveAs });
  }

  /*
   * --------------------------------------------------------------------------
   * Native file input interception
   * --------------------------------------------------------------------------
   */

  function installFilePickerPatch() {
    const prototype = window.HTMLInputElement?.prototype;

    if (!prototype) {
      warn("HTMLInputElement.prototype is unavailable");
      return;
    }

    /*
     * Use our own marker instead of the old __artcraftPickerPatched marker.
     * This prevents old adapter code from accidentally disabling this bridge.
     */
    if (prototype.__artcraftTfsFilePickerPatched) return;

    const nativeClick = prototype.click;

    Object.defineProperty(
      prototype,
      "__artcraftTfsFilePickerPatched",
      {
        configurable: false,
        enumerable: false,
        value: true
      }
    );

    prototype.click = function(...args) {
      if (
        this instanceof window.HTMLInputElement &&
        this.type?.toLowerCase() === "file"
      ) {
        const accept =
          this.getAttribute("accept") ||
          this.accept ||
          "*.*";

        const multiple = Boolean(this.multiple);

        log("Intercepted native file picker:", {
          accept,
          multiple
        });

        void openPicker({
          title:
            optionsForInput(this).title ||
            `Open in ${APP}`,
          filter: accept,
          multiple,
          input: this
        }).catch(error => {
          /*
           * "Open canceled" is normal user behavior.
           */
          if (error?.message === "Open canceled") return;

          alert("Could not open file", error);
        });

        return;
      }

      return nativeClick.apply(this, args);
    };
  }

  function optionsForInput(input) {
    const configured =
      window.__artcraftFilePickerOptions || {};

    return {
      title:
        configured.title ||
        `Open in ${APP}`,

      filter:
        configured.filter ||
        input?.accept ||
        "*.*"
    };
  }

  /*
   * --------------------------------------------------------------------------
   * Download interception
   * --------------------------------------------------------------------------
   *
   * This handles the common ArtCraft pattern:
   *
   *   const a = document.createElement("a");
   *   a.href = URL.createObjectURL(blob);
   *   a.download = "foo.svg";
   *   a.click();
   *
   * It intentionally does NOT interfere with ordinary anchor navigation.
   */

  function installDownloadPatch() {
    if (document.__artcraftTfsDownloadPatched) return;

    const nativeCreateElement =
      document.createElement.bind(document);

    Object.defineProperty(
      document,
      "__artcraftTfsDownloadPatched",
      {
        configurable: false,
        enumerable: false,
        value: true
      }
    );

    document.createElement = function(name, ...args) {
      const element =
        nativeCreateElement(name, ...args);

      if (String(name).toLowerCase() !== "a") {
        return element;
      }

      const nativeClick =
        element.click.bind(element);

      element.click = function(...clickArgs) {
        const downloadName = element.download;

        if (!downloadName) {
          return nativeClick(...clickArgs);
        }

        const blob =
          blobStore.get(element.href) ||
          window.__artcraftBlobUrlToBlob?.get(element.href);

        /*
         * If this isn't one of our tracked Blob URLs, don't break the app.
         */
        if (!(blob instanceof Blob)) {
          log(
            "Download link was not a tracked ArtCraft Blob; using native click."
          );

          return nativeClick(...clickArgs);
        }

        window.__artcraftCurrentExportName =
          basename(downloadName, `${APP}-export`);

        window.__artcraftSaveBlob = blob;
        window.__artcraftLastBlobUrl = element.href;

        log(
          "Intercepted export:",
          window.__artcraftCurrentExportName,
          blob.type,
          blob.size
        );

        /*
         * Don't invoke the browser's native download.
         *
         * A plain click means "save to Terbium" rather than download.
         * The actual SaveFile dialog is opened so the user can choose a path.
         */
        void saveLastExport({ saveAs: true })
          .then(path => {
            try {
              host()?.tb?.notification?.Toast?.({
                message: `Saved to ${path}`,
                application: APP
              });
            } catch {}

            return path;
          })
          .catch(error => {
            if (error?.message === "Save canceled") return;

            alert("Could not save file", error);
          });
      };

      return element;
    };
  }

  /*
   * --------------------------------------------------------------------------
   * Keyboard shortcuts
   * --------------------------------------------------------------------------
   */

  function installSaveShortcut() {
    if (window.__artcraftTfsSaveShortcutInstalled) return;
    window.__artcraftTfsSaveShortcutInstalled = true;

    window.addEventListener(
      "keydown",
      event => {
        if (
          !(event.ctrlKey || event.metaKey) ||
          event.key?.toLowerCase() !== "s"
        ) {
          return;
        }

        /*
         * Ignore shortcuts from browser/UI contexts where another system
         * intentionally owns the event.
         *
         * We still handle Ctrl+S for the ArtCraft document.
         */
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const saveAs = Boolean(event.shiftKey);

        log(
          saveAs
            ? "Ctrl+Shift+S -> Terbium Save As"
            : "Ctrl+S -> Terbium Save"
        );

        void saveLastExport({ saveAs })
          .then(path => {
            try {
              host()?.tb?.notification?.Toast?.({
                message: `Saved to ${path}`,
                application: APP
              });
            } catch {}
          })
          .catch(error => {
            if (error?.message === "Save canceled") return;

            /*
             * If there is no export yet, this is not necessarily an error:
             * apps often use Ctrl+S for their own native project format.
             */
            alert("Save in Terbium", error);
          });
      },
      true
    );
  }

  /*
   * --------------------------------------------------------------------------
   * localStorage -> Terbium FS persistence
   * --------------------------------------------------------------------------
   */

  const originalStorage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();

  const nativeStorage = {
    getItem:
      typeof originalStorage?.getItem === "function"
        ? originalStorage.getItem.bind(originalStorage)
        : () => null,

    setItem:
      typeof originalStorage?.setItem === "function"
        ? originalStorage.setItem.bind(originalStorage)
        : () => {},

    removeItem:
      typeof originalStorage?.removeItem === "function"
        ? originalStorage.removeItem.bind(originalStorage)
        : () => {},

    clear:
      typeof originalStorage?.clear === "function"
        ? originalStorage.clear.bind(originalStorage)
        : () => {},

    key:
      typeof originalStorage?.key === "function"
        ? originalStorage.key.bind(originalStorage)
        : () => null,

    get length() {
      return originalStorage?.length || 0;
    }
  };

  const storageCache = new Map();
  let storageReady = false;
  let storageFlush = Promise.resolve();
  let storageLoadPromise = null;

  function storageRoot() {
    const user = currentUser();

    return user
      ? `/home/${user}/.config/artcraft-terbium/${APP}`
      : `/home/.config/artcraft-terbium/${APP}`;
  }

  function storagePath(key) {
    const encoded = Array.from(
      new TextEncoder().encode(String(key)),
      byte => byte.toString(16).padStart(2, "0")
    ).join("");

    return `${storageRoot()}/${encoded}.json`;
  }

  async function ensureStorageDirectories(filesystem) {
    const root = storageRoot();
    const parent =
      root.slice(0, root.lastIndexOf("/"));

    await ensureDirectory(parent);
    await ensureDirectory(root);
  }

  function persistStorage(key, value) {
    key = String(key);
    value = String(value);

    storageCache.set(key, value);

    if (!storageReady) return;

    const filesystem = fs();
    if (!filesystem) return;

    storageFlush = storageFlush.then(async () => {
      try {
        await ensureStorageDirectories(filesystem);

        await filesystem.writeFile(
          storagePath(key),
          JSON.stringify({
            key,
            value
          }),
          "utf8"
        );
      } catch (error) {
        warn("Terbium TFS preference save failed:", error);
      }
    });
  }

  function removeStorage(key) {
    key = String(key);
    storageCache.delete(key);

    if (!storageReady) return;

    const filesystem = fs();
    if (!filesystem) return;

    storageFlush = storageFlush.then(async () => {
      try {
        await filesystem.unlink(storagePath(key));
      } catch {}
    });
  }

  const storage = {
    get length() {
      return storageCache.size;
    },

    key(index) {
      return Array.from(storageCache.keys())[index] ?? null;
    },

    getItem(key) {
      key = String(key);

      if (storageCache.has(key)) {
        return storageCache.get(key);
      }

      try {
        return nativeStorage.getItem(key);
      } catch {
        return null;
      }
    },

    setItem(key, value) {
      key = String(key);
      value = String(value);

      try {
        nativeStorage.setItem(key, value);
      } catch (error) {
        warn("Browser storage write failed:", error);
      }

      persistStorage(key, value);
    },

    removeItem(key) {
      key = String(key);

      try {
        nativeStorage.removeItem(key);
      } catch {}

      removeStorage(key);
    },

    clear() {
      const keys = Array.from(storageCache.keys());

      try {
        nativeStorage.clear();
      } catch {}

      for (const key of keys) {
        removeStorage(key);
      }
    },

    __restore(key, value) {
      key = String(key);
      value = String(value);

      storageCache.set(key, value);

      try {
        nativeStorage.setItem(key, value);
      } catch {}
    }
  };

  const storageProxy = new Proxy(storage, {
    get(target, property) {
      if (property === Symbol.toStringTag) {
        return "Storage";
      }

      if (property in target) {
        return Reflect.get(target, property);
      }

      if (typeof property === "string") {
        return target.getItem(property) ?? undefined;
      }

      return undefined;
    },

    set(target, property, value) {
      if (typeof property === "string") {
        target.setItem(property, value);
      }

      return true;
    },

    deleteProperty(target, property) {
      if (typeof property === "string") {
        target.removeItem(property);
      }

      return true;
    },

    defineProperty(target, property, descriptor) {
      if (
        typeof property === "string" &&
        Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        )
      ) {
        target.setItem(property, descriptor.value);
      }

      return true;
    },

    ownKeys() {
      return Array.from(storageCache.keys());
    },

    getOwnPropertyDescriptor(target, property) {
      if (
        typeof property === "string" &&
        storageCache.has(property)
      ) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: storageCache.get(property)
        };
      }

      return Object.getOwnPropertyDescriptor(
        target,
        property
      );
    }
  });

  function installStorageBridge() {
    if (!originalStorage) return;

    try {
      Object.defineProperty(
        window,
        "localStorage",
        {
          configurable: true,
          enumerable: true,
          value: storageProxy
        }
      );
    } catch (error) {
      warn(
        "Could not install Terbium TFS localStorage bridge:",
        error
      );
    }

    window.addEventListener("storage", event => {
      if (event.key === null) {
        for (const [key, value] of storageCache) {
          storage.__restore(key, value);
        }

        return;
      }

      if (event.newValue === null) {
        removeStorage(event.key);
      } else {
        persistStorage(
          event.key,
          event.newValue
        );
      }
    });
  }

  async function loadStorage() {
    if (storageLoadPromise) {
      return storageLoadPromise;
    }

    storageLoadPromise = (async () => {
      const filesystem = fs();

      if (filesystem) {
        try {
          await ensureStorageDirectories(filesystem);

          const root = storageRoot();
          const files = await filesystem.readdir(
            root,
            { recursive: true }
          );

          for (const entry of files) {
            const path =
              String(entry).startsWith(`${root}/`)
                ? String(entry)
                : `${root}/${entry}`;

            if (!path.endsWith(".json")) continue;

            try {
              const raw =
                await filesystem.readFile(path, "utf8");

              const text =
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(raw);

              const item = JSON.parse(text);

              if (
                item &&
                typeof item.key === "string" &&
                typeof item.value === "string"
              ) {
                storage.__restore(
                  item.key,
                  item.value
                );
              }
            } catch (error) {
              warn(
                "Terbium TFS preference read failed:",
                path,
                error
              );
            }
          }
        } catch (error) {
          warn(
            "Terbium TFS storage unavailable; using browser storage:",
            error
          );
        }
      }

      /*
       * Merge any browser-local keys that weren't present in TFS.
       */
      try {
        for (
          let index = 0;
          index < nativeStorage.length;
          index++
        ) {
          const key = nativeStorage.key(index);

          if (
            key !== null &&
            !storageCache.has(key)
          ) {
            const value =
              nativeStorage.getItem(key);

            if (value !== null) {
              storageCache.set(key, value);
            }
          }
        }
      } catch {}

      storageReady = true;

      /*
       * Push merged browser keys into TFS.
       */
      for (const [key, value] of storageCache) {
        persistStorage(key, value);
      }

      log(
        "Storage bridge ready:",
        storageCache.size,
        "keys"
      );
    })();

    return storageLoadPromise;
  }

  installStorageBridge();

  /*
   * --------------------------------------------------------------------------
   * Public bridge
   * --------------------------------------------------------------------------
   */

  const bridge = {
    version: BRIDGE_VERSION,
    app: APP,

    openFile: readFile,
    openPicker,
    openSelectedFile,

    saveFile,
    chooseSave,

    saveLastBlob,
    saveLastExport,

    get currentExport() {
      return currentExportBlob();
    },

    get blobStore() {
      return blobStore;
    }
  };

  /*
   * Don't blindly replace an existing bridge if another copy of this exact
   * integration already installed one.
   */
  window.artcraftTfs = bridge;
  window.__artcraftTfsBridgeInstalledFor = APP;

  /*
   * These globals are intentionally kept for compatibility with existing
   * ArtCraft adapters.
   */
  window.__artcraftBlobStore = blobStore;

  /*
   * Default picker settings can be overridden by the app-specific adapter:
   *
   * window.__artcraftFilePickerOptions = {
   *   title: "Open in VectorCraft",
   *   filter: ".svg,.svgz"
   * };
   */
  window.__artcraftFilePickerOptions ||= {
    title: `Open in ${APP}`,
    filter: "*.*"
  };

  /*
   * Install the important hooks.
   */
  installBlobTracking();
  installFilePickerPatch();
  installDownloadPatch();
  installSaveShortcut();

  /*
   * Compatibility events used by older integration code.
   */
  window.addEventListener(
    "artcraft:open-file",
    event => {
      const path = event.detail?.path;

      if (typeof path !== "string") return;

      void openFile(path).catch(error => {
        alert("Could not open file", error);
      });
    }
  );

  window.addEventListener(
    "artcraft:save-file",
    event => {
      const detail = event.detail || {};

      void saveFile(
        detail.name,
        detail.bytes,
        Boolean(detail.saveAs),
        detail.suggestedPath || null
      )
        .then(result => detail.resolve?.(result))
        .catch(error => detail.reject?.(error));
    }
  );

  window.__artcraftTfsBridge = {
    version: BRIDGE_VERSION,
    openFile: readFile,
    openPicker,
    saveFile,
    saveLastExport,
    blobStore
  };

  /*
   * Start storage loading asynchronously. File open/save functionality does
   * not depend on this completing.
   */
  void loadStorage();

  log(
    `ArtCraft TFS bridge ${BRIDGE_VERSION} installed for ${APP}`
  );
})();
