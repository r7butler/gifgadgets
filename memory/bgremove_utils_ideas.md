1. under Image tools - remove background from image
    - I figure we can leverage the SAM2 that we have in Modal. Let the user click on an object (or objects), remove everything else, export just that.
2. Under Image tools - change image background
    - Same idea here as item number 1, except here, I figure we can let them swap the background for a new one
3. Under gif tools - remove background from gif
    - let them click on an object (or objects), let SAM2 segment it, remove the background, export the gif
4. Under gif tools - swap gif background
    - same idea and let them put another image or gif as the background

Comments/concerns
- GPU runtime cost for gifs with many frames? should we set a frame limit?
  For now, no. But I'd like whichever model works on this task to give their insight/input on this matter. I just want to implement like this for now and monitor behavior and cost.

## Implementation status — September 17, 2026

All four tools are implemented locally, continuing the previously started work:

- `/remove-image-background/`
- `/change-image-background/`
- `/remove-gif-background/`
- `/swap-gif-background/`

Multiple-object selection, keep/exclude points, PNG/GIF export and animated GIF
replacement backgrounds are supported. No fixed frame cap or frame sampling was
added. Background changes reuse the masks without another GPU run.

See [implementation, GPU cost input and deployment notes](docs/background-utilities.md).
This work has not been deployed; the live SAM2 smoke test remains a deployment check.
