const RELOAD_KEY = 'work_platform_module_reload';
let reloadRequested = false;

export function isModuleLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') {
    return false;
  }

  return /^(Failed to fetch dynamically imported module(?:\s|:|$)|error loading dynamically imported module(?:\s|:|$)|Importing a module script failed(?:\.|:|$)|Unable to preload CSS for\s)/i.test(error.message);
}

export function recoverFromModuleLoadError(error: unknown): boolean {
  if (!isModuleLoadError(error) || reloadRequested || !navigator.onLine) return false;

  try {
    // The bundle URL changes with each build; keep the guard across reloads of the same build.
    if (window.sessionStorage.getItem(RELOAD_KEY) === import.meta.url) return false;
    window.sessionStorage.setItem(RELOAD_KEY, import.meta.url);
  } catch {
    return false;
  }

  reloadRequested = true;
  window.location.reload();
  return true;
}
