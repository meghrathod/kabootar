import { type Component } from "solid-js";
import {
  Dialog,
  DialogOverlay,
  DialogPanel,
  Transition,
  TransitionChild,
} from "solid-headless";
import { Portal } from "solid-js/web";
import QRCode from "qrcode-svg";

const QRDialog: Component<{
  open: boolean;
  url: string;
  close: () => void;
}> = (props) => {
  const qr = () =>
    new QRCode({
      content: props.url === "" ? "kabootar" : props.url,
      padding: 0,
      color: "white",
      background: "transparent",
    }).svg();

  return (
    <Portal>
      <Transition appear show={props.open}>
        <Dialog
          isOpen
          class="fixed inset-0 z-[99999] overflow-y-auto"
          onClose={props.close}
        >
          <div class="min-h-screen px-4 flex items-center justify-center">
            <TransitionChild
              enter="ease-out duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <DialogOverlay class="fixed inset-0 bg-gray-900 bg-opacity-50" />
            </TransitionChild>

            {/* This element is to trick the browser into centering the modal contents. */}
            <span class="inline-block h-screen align-middle" aria-hidden="true">
              &#8203;
            </span>
            <TransitionChild
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel class="dialog-panel">
                <div innerHTML={qr()} />
                <div class="mt-4">
                  <button
                    type="button"
                    class="rounded font-bold px-3 py-2 w-full"
                    style={{ background: "rgba(255, 255, 255, 0.2)" }}
                    onClick={props.close}
                  >
                    Close
                  </button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </Dialog>
      </Transition>
    </Portal>
  );
};

export default QRDialog;
