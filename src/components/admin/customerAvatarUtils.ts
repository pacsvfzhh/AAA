const customAvatarStates = new Map<string, 'loading' | 'loaded' | 'error'>();
const customAvatarRequests = new Map<string, Promise<boolean>>();

export function preloadCustomerAvatar(customAvatarUrl?: string | null) {
  const url = customAvatarUrl?.trim();
  if (!url) return Promise.resolve(false);

  const state = customAvatarStates.get(url);
  if (state === 'loaded') return Promise.resolve(true);
  if (state === 'error') return Promise.resolve(false);

  const pending = customAvatarRequests.get(url);
  if (pending) return pending;

  customAvatarStates.set(url, 'loading');
  const request = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => {
      customAvatarStates.set(url, 'loaded');
      resolve(true);
    };
    image.onerror = () => {
      customAvatarStates.set(url, 'error');
      resolve(false);
    };
    image.src = url;
  });
  customAvatarRequests.set(url, request);
  request.finally(() => customAvatarRequests.delete(url));
  return request;
}

export { customAvatarStates };
