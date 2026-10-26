import { configStore } from "../store/configStore";
import {
  PERSISTENT_KEYS,
  scheduleSavePersistentPreferences,
} from "../utils/persistentPreferences";

const storageInstance: Storage = {
  getItem: (key: string, defaultValue = ""): string => {
    const item: string = window.localStorage.getItem(key) ?? defaultValue;
    return item;
  },
  setItem: (key: string, value: string): void => {
    window.localStorage.setItem(key, value);
    configStore.getState().bumpPrefTick();
    if (PERSISTENT_KEYS.includes(key as any)) {
      scheduleSavePersistentPreferences();
    }
  },
  removeItem: (key: string): void => {
    window.localStorage.removeItem(key);
    configStore.getState().bumpPrefTick();
    if (PERSISTENT_KEYS.includes(key as any)) {
      scheduleSavePersistentPreferences();
    }
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
