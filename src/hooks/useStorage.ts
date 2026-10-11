const storageInstance: Storage = {
  getItem: (key: string, defaultValue: string): string => {
    const item: string = window.localStorage.getItem(key) ?? defaultValue;
    return item;
  },
  setItem: (key: string, value: any): void => {
    window.localStorage.setItem(key, value);
  },
  removeItem: (key: string): void => {
    window.localStorage.removeItem(key);
  },
};

function useStorage(): Storage {
  return storageInstance;
}

export default useStorage;

interface Storage {
  getItem: (key: string, defaultValue: string) => string;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}
