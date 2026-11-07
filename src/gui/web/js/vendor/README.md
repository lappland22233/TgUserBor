`jsQR.js` is the unmodified browser distribution of jsQR 1.4.0. It is loaded
only when Telegram's Mini App QR scanner is opened in a browser without the
native `BarcodeDetector` API. QR decoding stays in the browser; camera frames
are not sent to the server.

jsQR is licensed under Apache-2.0. See `jsQR-LICENSE.txt`.
