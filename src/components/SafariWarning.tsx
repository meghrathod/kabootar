import { Component, Show, createSignal, onMount } from "solid-js";
import { isSafariOrIOS } from "../utils/browser";

const SafariWarning: Component = () => {
  const [visible, setVisible] = createSignal(true);
  const [animateOut, setAnimateOut] = createSignal(false);

  const closeWarning = () => {
    setAnimateOut(true);
    setTimeout(() => setVisible(false), 300);
  };

  onMount(() => {
    if (isSafariOrIOS()) {
      setTimeout(() => closeWarning(), 10000);
    }
  });

  return (
    <Show when={visible() && isSafariOrIOS()}>
      <div 
        class={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-96 rounded-lg border border-gray-200 bg-background p-0 
                shadow-md animate-in fade-in-0 zoom-in-95 
                ${animateOut() ? 'opacity-0 translate-y-[-8px]' : 'opacity-100'}`}
        style="transition: all 0.3s ease"
        role="alert"
      >
        <div class="flex flex-col space-y-1.5 p-4 text-left">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                stroke-width="2" 
                stroke-linecap="round" 
                stroke-linejoin="round" 
                class="text-amber-500"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
              <h5 class="text-sm font-medium">Safari Limitation</h5>
            </div>
            <button 
              onClick={closeWarning} 
              class="rounded-full h-5 w-5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="14" 
                height="14" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                stroke-width="2" 
                stroke-linecap="round" 
                stroke-linejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="text-sm text-muted-foreground">
            Your browser has a 2GB file size limitation for transfers.
            Files larger than 2GB may not download correctly.
          </div>
        </div>
      </div>
    </Show>
  );
};

export default SafariWarning;