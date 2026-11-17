// Paddle's checkout, from Paddle.js. Paddle sells the plans: it shows the price with tax, takes the card
// and tells the Mergelight server about the new subscription. The page only opens the checkout, and
// passes on the custom data the server signed, which says which org the plan is for.

const SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';

interface PaddleEvent {
  name?: string;
}

interface PaddleJs {
  Environment: { set: (env: 'sandbox') => void };
  Initialize: (options: { token: string; eventCallback: (event: PaddleEvent) => void }) => void;
  Checkout: {
    open: (options: { items: { priceId: string; quantity: number }[]; customData: Record<string, string>; settings: { displayMode: 'overlay'; theme: 'dark' | 'light'; allowLogout: boolean } }) => void;
  };
}

declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

let loading: Promise<PaddleJs> | null = null;
/** Paddle.js takes one setup per page, so the checkout's events go to whatever asked last. */
let onEvent: (event: PaddleEvent) => void = () => undefined;
let setUpFor: string | null = null;

function loadPaddle(): Promise<PaddleJs> {
  loading ??= new Promise<PaddleJs>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error("Paddle's checkout didn't load.")));
    script.onerror = () => {
      loading = null;
      reject(new Error("Paddle's checkout didn't load. Check your connection, or turn off a blocker for cdn.paddle.com."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export interface Checkout {
  env: 'sandbox' | 'live';
  clientToken: string;
  priceId: string;
  seats: number;
  customData: Record<string, string>;
}

/** Opens Paddle's checkout over the page. done runs when the payment went through. */
export async function openCheckout(checkout: Checkout, done: () => void): Promise<void> {
  const paddle = await loadPaddle();
  onEvent = (event) => {
    if (event.name === 'checkout.completed') done();
  };
  if (setUpFor !== checkout.clientToken) {
    if (checkout.env === 'sandbox') paddle.Environment.set('sandbox');
    paddle.Initialize({ token: checkout.clientToken, eventCallback: (event) => onEvent(event) });
    setUpFor = checkout.clientToken;
  }
  paddle.Checkout.open({
    items: [{ priceId: checkout.priceId, quantity: checkout.seats }],
    customData: checkout.customData,
    settings: { displayMode: 'overlay', theme: 'dark', allowLogout: false },
  });
}
