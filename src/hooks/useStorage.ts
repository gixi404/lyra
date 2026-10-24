import { configStore } from "../store/configStore";

const storageInstance: Storage = {
  getItem: (key: string, defaultValue = ""): string => {
    const item: string = window.localStorage.getItem(key) ?? defaultValue;
    return item;
  },
  setItem: (key: string, value: string): void => {
    window.localStorage.setItem(key, value);
    configStore.getState().bumpPrefTick();
  },
  removeItem: (key: string): void => {
    window.localStorage.removeItem(key);
    configStore.getState().bumpPrefTick();
  },
};

function useStorage(): Storage {
  return storageInstance;
}

export default useStorage;

interface Storage {
  getItem: (key: string, defaultValue?: string) => string;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}
