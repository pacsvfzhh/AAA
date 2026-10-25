// Safari with "Block All Cookies" and some in-app browsers throw on any localStorage / sessionStorage access, which
// stops the app before it renders. Falling back to in-memory storage keeps it usable for the life of the page.
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(String(key)) ? (data.get(String(key)) as string) : null),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(String(key));
    },
    setItem: (key: string, value: string) => {
      data.set(String(key), String(value));
    },
  };
  return storage as Storage;
}

function ensureStorage(name: 'localStorage' | 'sessionStorage') {
  try {
    window[name].getItem('__storage_probe__');
  } catch {
    try {
      Object.defineProperty(window, name, { value: createMemoryStorage(), configurable: true });
    } catch {
      // The property is locked; nothing more can be done.
    }
  }
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
