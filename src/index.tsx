/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";

import App from "./App";

// noinspection JSIgnoredPromiseFromCall
navigator.serviceWorker.register("/sw.js", { scope: "/" });

render(() => <App />, document.getElementById("root"));
