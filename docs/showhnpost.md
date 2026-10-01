Title: Show HN: GifGadgets – browser GIF tools, AI object tracking/background removal

url: https://gifgadgets.com/

text: Hi HN, I built GifGadgets, a set of GIF and image tools that run in your browser. I built it to be mobile friendly first, since I've had trouble using most gif editors online on my phone

I'm a solo developer with a day job, so I built it to need very little maintenance.

Most of it is plain client-side work: resize, crop, reverse, convert, add text and so on. For those, files stay on your device, there's no sign-up, and there's no upload size cap beyond what your browser's memory can handle. Exports carry a watermark by default, which you can turn off.

Two features use a GPU on the backend. Follow an Object: you click something in the GIF and a caption tracks it frame by frame (SAM 2). Remove or swap background: you click the subject and it masks it across every frame (SAM 3.1), then you can drop in a new background or a transparent one.

A few limits so you aren't surprised. The AI features run on a prepaid GPU budget that I'm paying for personally, so if a lot of you try them it may run out of credit and the feature will be unavailable until I top it up. The sample GIFs use precomputed results, so the demo works either way. Background removal in the demo is limited: [FILL IN]. Cold starts can take a minute while the model loads.

I'd love feedback on where it breaks, especially odd GIFs, large files and anything the tracking gets wrong. Happy to answer questions about how it's built.