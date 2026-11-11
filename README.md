# Posture

A posture coach for [workshop](https://github.com/DoshaLabs/workshop)'s tile column. The camera
watches how you sit against how you calibrated, keeps a streak while you sit well, and nudges you
after ten seconds of slouching. It also reads three gestures: hold a **thumbs up**, a **thumbs down** or a **middle
finger** up to the camera and the session you're working in hears about it.

Everything runs on your Mac. The pose and hand models and MediaPipe's WebAssembly ship inside the
tile, so it has no network permission at all: no frame, number or gesture can leave the machine.

## What it asks for

- `camera`: to see you. Pause turns it off.
- `storage`: your calibration, strictness, the last three hours of history, and the gesture log.
- `notify`: the slouch nudge (and your session's status mark jumps once).
- `sessions: "write"`: a gesture is typed into the session in focus as a short message
  (`👍 (a thumbs-up, from the camera: I like this)`). Turn off "Tell the session in focus" in the
  pane and gestures are only counted.

## Use

Turn the tile on, press **Calibrate**, sit the way you want to sit and hold still for a few
seconds. The tile shows your streak, the last two hours in a line and today's gestures; click it for
the pane: the feed large, the five checks (head height, leaning in, slumping, side lean, chin on
hand), the last two hours with totals, strictness, and the gestures.

A gesture counts after you hold it for about half a second, once; drop your hand to make another.
The same gesture again waits six seconds.

## Develop

Plain HTML, CSS and JavaScript modules in `dist/`, no build step. The rules are pure modules
tested as shipped: `node --test 'test/*.test.mjs'`. Load the folder with `workshop tile dev .`;
check it with `workshop tile check .`.

Ported from deck's Posture tile, itself [Posture Pal](https://github.com/cgrilson7/posture-pal).
MediaPipe and its models are Google's, under Apache-2.0 (`dist/vendor/LICENSE-mediapipe.txt`).
