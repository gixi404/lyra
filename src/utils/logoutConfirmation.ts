export function createLogoutConfirmation(logout: () => Promise<boolean>) {
  let pending = false;
  let open = false;
  return {
    isPending: () => pending,
    open: () => { open = true; },
    cancel: () => { if (!pending) open = false; },
    confirm: async (): Promise<boolean> => {
      if (!open || pending) return false;
      pending = true;
      try {
        const succeeded = await logout();
        if (succeeded) open = false;
        return succeeded;
      } finally {
        pending = false;
      }
    },
  };
}
