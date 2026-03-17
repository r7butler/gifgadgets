/* ==========================================================
   GifCaption – D3 Brush Timeline

   Frame-range timeline built with D3.js.  Each on-image
   caption gets a horizontal brush track so the user can
   drag its start/end frames.  A red playhead follows the
   current frame.

   This module is GIF-specific (frame-based timing).

   Depends on:
     editor-state.js      (GC namespace, state, TRACK_COLORS)
     canvas-rendering.js  (GC.renderCurrentFrame)
     gif-playback.js      (GC.seekFrame, GC.play, GC.pause)
     D3.js v7             (d3 global)
   ========================================================== */

(function () {
  'use strict';

  var state = GC.state;

  /**
   * (Re)build the SVG timeline from scratch.
   * Called after captions are added/removed, after frame-range
   * edits, and on window resize.
   */
  GC.buildTimeline = function () {
    var container = document.getElementById('timeline');
    if (!container) return;   // no timeline in still-image mode
    container.innerHTML = '';

    if (state.frames.length === 0) return;

    var totalFrames = state.frames.length;
    var trackH = 34;
    var rulerH = 28;
    var margin = { top: 8, right: 24, bottom: 4, left: 110 };
    var cw = container.clientWidth || window.innerWidth || 800;
    var innerW = cw - margin.left - margin.right;
    var numCaptionTracks = Math.max(state.captions.length, 0);
    var numOverlayTracks = state.overlays ? state.overlays.length : 0;
    var numTracks = numCaptionTracks + numOverlayTracks;
    var motionCaps = state.captions.filter(function (c) { return c.motion && c.motion.length > 0; });
    var motionOvs = state.overlays ? state.overlays.filter(function (o) { return o.motion && o.motion.length > 0; }) : [];
    var totalMotionTracks = motionCaps.length + motionOvs.length;
    var totalH = margin.top + numTracks * trackH + rulerH + margin.bottom +
      (totalMotionTracks > 0 ? totalMotionTracks * trackH + 20 : 0);

    var xScale = d3.scaleLinear().domain([0, totalFrames - 1]).range([0, innerW]);

    var svg = d3.select(container).append('svg')
      .attr('width', cw).attr('height', Math.max(totalH, 60));

    var g = svg.append('g')
      .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    // ── Frame ruler (bottom axis) ──────────────
    var rulerG = g.append('g')
      .attr('transform', 'translate(0,' + (numTracks * trackH) + ')');

    var tickCount = Math.min(totalFrames, Math.floor(innerW / 40));
    rulerG.call(d3.axisBottom(xScale).ticks(tickCount).tickFormat(function (d) { return Math.round(d); }))
      .selectAll('text').attr('fill', '#777').attr('font-size', 10);
    rulerG.selectAll('line').attr('stroke', '#444');
    rulerG.selectAll('path').attr('stroke', '#444');

    // Click on the ruler to seek to that frame
    rulerG.append('rect')
      .attr('width', innerW).attr('height', rulerH)
      .attr('fill', 'transparent').attr('cursor', 'pointer')
      .on('click', function (event) {
        var mx = d3.pointer(event)[0];
        GC.seekFrame(Math.round(xScale.invert(mx)));
      });

    // ── Caption brush tracks ───────────────────
    state.captions.forEach(function (cap, idx) {
      var ty = idx * trackH;
      var tg = g.append('g').attr('transform', 'translate(0,' + ty + ')');

      // Dark track background
      tg.append('rect')
        .attr('width', innerW).attr('height', trackH - 4)
        .attr('fill', '#14142a').attr('rx', 4)
        .attr('stroke', '#2a2a44').attr('stroke-width', 1);

      // Truncated caption label (clickable to select)
      var labelText = cap.text.length > 14 ? cap.text.substring(0, 14) + '…' : cap.text;
      svg.append('text')
        .attr('x', margin.left - 10)
        .attr('y', margin.top + ty + (trackH - 4) / 2)
        .attr('text-anchor', 'end')
        .attr('dominant-baseline', 'central')
        .attr('fill', cap.id === state.selectedCaptionId ? GC.TRACK_COLORS[idx % GC.TRACK_COLORS.length] : '#888')
        .attr('font-size', 12)
        .attr('font-weight', cap.id === state.selectedCaptionId ? '700' : '400')
        .attr('cursor', 'pointer')
        .text(labelText)
        .on('click', function () { GC.selectCaption(cap.id); });

      // D3 brush for adjusting start/end frames
      var prevSel = null;
      var dragEdge = null; // 'start' | 'end' | 'both'
      var userDragging = false;

      var brush = d3.brushX()
        .extent([[0, 2], [innerW, trackH - 6]])
        .on('start', function (event) {
          if (!event.sourceEvent) return; // ignore programmatic moves
          userDragging = true;
          state._brushActive = true;
          prevSel = event.selection ? event.selection.slice() : null;
          dragEdge = null;
          GC.selectCaption(cap.id);
          // Pause playback during brush interaction
          if (state.isPlaying) {
            state._wasPlayingBeforeBrush = true;
            GC.pause();
          }
        })
        .on('brush', function (event) {
          if (!event.selection || !userDragging) return;
          var s0 = Math.round(xScale.invert(event.selection[0]));
          var s1 = Math.round(xScale.invert(event.selection[1]));
          cap.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
          cap.endFrame = Math.max(cap.startFrame, Math.min(totalFrames - 1, s1));

          // Preview the frame at whichever edge the user is dragging
          var targetFrame;
          try {
            var pointerX = d3.pointer(event.sourceEvent, this)[0];
            var distToStart = Math.abs(pointerX - event.selection[0]);
            var distToEnd = Math.abs(pointerX - event.selection[1]);
            targetFrame = distToStart < distToEnd ? cap.startFrame : cap.endFrame;
          } catch (e) {
            if (!dragEdge && prevSel) {
              var startMoved = Math.abs(event.selection[0] - prevSel[0]) > 0.5;
              var endMoved = Math.abs(event.selection[1] - prevSel[1]) > 0.5;
              if (startMoved && !endMoved) dragEdge = 'start';
              else if (endMoved && !startMoved) dragEdge = 'end';
              else dragEdge = 'both';
            }
            if (dragEdge === 'start') {
              targetFrame = cap.startFrame;
            } else if (dragEdge === 'end') {
              targetFrame = cap.endFrame;
            } else {
              var midX = (event.selection[0] + event.selection[1]) / 2;
              targetFrame = Math.round(xScale.invert(midX));
              targetFrame = Math.max(0, Math.min(totalFrames - 1, targetFrame));
            }
          }

          prevSel = event.selection.slice();
          state.currentFrame = targetFrame;
          GC.renderCurrentFrame();
          GC.movePlayhead();
          GC.updatePlaybackUI();
        })
        .on('end', function (event) {
          if (!userDragging) return;
          userDragging = false;
          state._brushActive = false;
          if (event.selection) {
            var s0 = Math.round(xScale.invert(event.selection[0]));
            var s1 = Math.round(xScale.invert(event.selection[1]));
            cap.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
            cap.endFrame = Math.max(cap.startFrame, Math.min(totalFrames - 1, s1));
          }
          GC.updateCaptionList();
          GC.renderCurrentFrame();
          GC.updatePlaybackUI();
          if (state._wasPlayingBeforeBrush) {
            state._wasPlayingBeforeBrush = false;
            GC.play();
          }
        });

      var brushG = tg.append('g').attr('class', 'caption-brush')
        .call(brush)
        .call(brush.move, [xScale(cap.startFrame), xScale(cap.endFrame)]);

      // Style the brush selection and handles
      brushG.selectAll('.selection')
        .attr('fill', GC.TRACK_COLORS[idx % GC.TRACK_COLORS.length])
        .attr('fill-opacity', 0.45)
        .attr('stroke', GC.TRACK_COLORS[idx % GC.TRACK_COLORS.length])
        .attr('rx', 4);

      brushG.selectAll('.handle')
        .attr('fill', GC.TRACK_COLORS[idx % GC.TRACK_COLORS.length])
        .attr('width', 6)
        .attr('rx', 2);
    });

    // ── Overlay brush tracks ─────────────────────
    if (state.overlays) {
      state.overlays.forEach(function (ov, idx) {
        var ty = (numCaptionTracks + idx) * trackH;
        var tg = g.append('g').attr('transform', 'translate(0,' + ty + ')');

        tg.append('rect')
          .attr('width', innerW).attr('height', trackH - 4)
          .attr('fill', '#14142a').attr('rx', 4)
          .attr('stroke', '#2a2a44').attr('stroke-width', 1);

        var labelText = ov.name.length > 14 ? ov.name.substring(0, 14) + '…' : ov.name;
        svg.append('text')
          .attr('x', margin.left - 10)
          .attr('y', margin.top + ty + (trackH - 4) / 2)
          .attr('text-anchor', 'end')
          .attr('dominant-baseline', 'central')
          .attr('fill', ov.id === state.selectedOverlayId ? '#f59e0b' : '#888')
          .attr('font-size', 12)
          .attr('font-weight', ov.id === state.selectedOverlayId ? '700' : '400')
          .attr('cursor', 'pointer')
          .text(labelText)
          .on('click', function () { if (GC.selectOverlay) GC.selectOverlay(ov.id); });

        var prevSel = null;
        var dragEdge = null;
        var userDragging = false;

        var brush = d3.brushX()
          .extent([[0, 2], [innerW, trackH - 6]])
          .on('start', function (event) {
            if (!event.sourceEvent) return;
            userDragging = true;
            state._brushActive = true;
            prevSel = event.selection ? event.selection.slice() : null;
            dragEdge = null;
            if (GC.selectOverlay) GC.selectOverlay(ov.id);
            if (state.isPlaying) { state._wasPlayingBeforeBrush = true; GC.pause(); }
          })
          .on('brush', function (event) {
            if (!event.selection || !userDragging) return;
            var s0 = Math.round(xScale.invert(event.selection[0]));
            var s1 = Math.round(xScale.invert(event.selection[1]));
            ov.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
            ov.endFrame = Math.max(ov.startFrame, Math.min(totalFrames - 1, s1));
            var targetFrame;
            try {
              var pointerX = d3.pointer(event.sourceEvent, this)[0];
              var distToStart = Math.abs(pointerX - event.selection[0]);
              var distToEnd = Math.abs(pointerX - event.selection[1]);
              targetFrame = distToStart < distToEnd ? ov.startFrame : ov.endFrame;
            } catch (e) {
              if (!dragEdge && prevSel) {
                var startMoved = Math.abs(event.selection[0] - prevSel[0]) > 0.5;
                var endMoved = Math.abs(event.selection[1] - prevSel[1]) > 0.5;
                if (startMoved && !endMoved) dragEdge = 'start';
                else if (endMoved && !startMoved) dragEdge = 'end';
                else dragEdge = 'both';
              }
              if (dragEdge === 'start') targetFrame = ov.startFrame;
              else if (dragEdge === 'end') targetFrame = ov.endFrame;
              else {
                var midX = (event.selection[0] + event.selection[1]) / 2;
                targetFrame = Math.round(xScale.invert(midX));
                targetFrame = Math.max(0, Math.min(totalFrames - 1, targetFrame));
              }
            }
            prevSel = event.selection.slice();
            state.currentFrame = targetFrame;
            GC.renderCurrentFrame();
            GC.movePlayhead();
            GC.updatePlaybackUI();
          })
          .on('end', function (event) {
            if (!userDragging) return;
            userDragging = false;
            state._brushActive = false;
            if (event.selection) {
              var s0 = Math.round(xScale.invert(event.selection[0]));
              var s1 = Math.round(xScale.invert(event.selection[1]));
              ov.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
              ov.endFrame = Math.max(ov.startFrame, Math.min(totalFrames - 1, s1));
            }
            GC.renderCurrentFrame();
            GC.updatePlaybackUI();
            if (state._wasPlayingBeforeBrush) { state._wasPlayingBeforeBrush = false; GC.play(); }
          });

        var brushG = tg.append('g').attr('class', 'caption-brush')
          .call(brush)
          .call(brush.move, [xScale(ov.startFrame), xScale(ov.endFrame)]);

        brushG.selectAll('.selection')
          .attr('fill', '#f59e0b')
          .attr('fill-opacity', 0.45)
          .attr('stroke', '#f59e0b')
          .attr('rx', 4);

        brushG.selectAll('.handle')
          .attr('fill', '#f59e0b')
          .attr('width', 6)
          .attr('rx', 2);
      });
    }

    // ── Motion keyframe rows ───────────────────
    if (totalMotionTracks > 0) {
      var motionBaseY = numTracks * trackH + rulerH + 4;

      g.append('text')
        .attr('x', -margin.left + 4)
        .attr('y', motionBaseY + 12)
        .attr('fill', '#555')
        .attr('font-size', 10)
        .attr('font-weight', '600')
        .text('MOTION');

      motionCaps.forEach(function (cap, mIdx) {
        var capIdx = state.captions.indexOf(cap);
        var color = GC.TRACK_COLORS[capIdx % GC.TRACK_COLORS.length];
        var my = motionBaseY + 18 + mIdx * trackH;
        var mg = g.append('g').attr('transform', 'translate(0,' + my + ')');

        // Track background
        mg.append('rect')
          .attr('width', innerW)
          .attr('height', trackH - 4)
          .attr('fill', '#14142a')
          .attr('rx', 4)
          .attr('stroke', '#2a2a44')
          .attr('stroke-width', 1);

        // Track label
        var labelText = cap.text.length > 12 ? cap.text.substring(0, 12) + '…' : cap.text;
        svg.append('text')
          .attr('x', margin.left - 10)
          .attr('y', margin.top + my + (trackH - 4) / 2)
          .attr('text-anchor', 'end')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#555')
          .attr('font-size', 11)
          .text('↔ ' + labelText);

        // Diamond markers — drag to move, right-click/tap to remove
        cap.motion.forEach(function (kf) {
          var kfMidY = (trackH - 4) / 2;
          var kfG = mg.append('g')
            .attr('transform', 'translate(' + xScale(kf.frame) + ',' + kfMidY + ')')
            .attr('cursor', 'ew-resize');

          // Hit target (larger than the visual diamond for easier interaction)
          kfG.append('rect')
            .attr('width', 20).attr('height', 20)
            .attr('x', -10).attr('y', -10)
            .attr('fill', 'transparent');

          // Visual diamond
          kfG.append('rect')
            .attr('width', 10).attr('height', 10)
            .attr('x', -5).attr('y', -5)
            .attr('fill', color)
            .attr('transform', 'rotate(45)')
            .attr('stroke', '#0c0c14').attr('stroke-width', 1);

          // Track total movement to distinguish tap from drag
          var totalMoved = 0;

          kfG.call(d3.drag()
            .on('start', function () {
              totalMoved = 0;
              if (state.isPlaying) GC.pause();
            })
            .on('drag', function (event) {
              totalMoved += Math.abs(event.dx) + Math.abs(event.dy);
              var newFrame = Math.round(xScale.invert(Math.max(0, Math.min(innerW, event.x))));
              newFrame = Math.max(0, Math.min(totalFrames - 1, newFrame));
              kf.frame = newFrame;
              state.currentFrame = newFrame;
              kfG.attr('transform', 'translate(' + xScale(newFrame) + ',' + kfMidY + ')');
              GC.renderCurrentFrame();
              GC.movePlayhead();
              GC.updatePlaybackUI();
            })
            .on('end', function (event) {
              if (totalMoved < 4) {
                // Treat as a tap on mobile (touch events produce no contextmenu)
                var src = event.sourceEvent;
                if (src && src.type === 'touchend') {
                  showKfMenu(src.changedTouches[0].clientX, src.changedTouches[0].clientY, kf, cap);
                  return;
                }
              }
              GC.buildTimeline();
            })
          );

          // Desktop right-click → context menu
          kfG.on('contextmenu', function (event) {
            event.preventDefault();
            event.stopPropagation();
            showKfMenu(event.clientX, event.clientY, kf, cap);
          });
        });
      });

      // Overlay motion keyframe rows
      motionOvs.forEach(function (ov, moIdx) {
        var color = '#f59e0b';
        var my = motionBaseY + 18 + (motionCaps.length + moIdx) * trackH;
        var mg = g.append('g').attr('transform', 'translate(0,' + my + ')');

        mg.append('rect')
          .attr('width', innerW).attr('height', trackH - 4)
          .attr('fill', '#14142a').attr('rx', 4)
          .attr('stroke', '#2a2a44').attr('stroke-width', 1);

        var labelText = ov.name.length > 12 ? ov.name.substring(0, 12) + '…' : ov.name;
        svg.append('text')
          .attr('x', margin.left - 10)
          .attr('y', margin.top + my + (trackH - 4) / 2)
          .attr('text-anchor', 'end')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#555')
          .attr('font-size', 11)
          .text('↔ ' + labelText);

        ov.motion.forEach(function (kf) {
          var kfMidY = (trackH - 4) / 2;
          var kfG = mg.append('g')
            .attr('transform', 'translate(' + xScale(kf.frame) + ',' + kfMidY + ')')
            .attr('cursor', 'ew-resize');

          kfG.append('rect')
            .attr('width', 20).attr('height', 20)
            .attr('x', -10).attr('y', -10)
            .attr('fill', 'transparent');

          kfG.append('rect')
            .attr('width', 10).attr('height', 10)
            .attr('x', -5).attr('y', -5)
            .attr('fill', color)
            .attr('transform', 'rotate(45)')
            .attr('stroke', '#0c0c14').attr('stroke-width', 1);

          var totalMoved = 0;
          kfG.call(d3.drag()
            .on('start', function () { totalMoved = 0; if (state.isPlaying) GC.pause(); })
            .on('drag', function (event) {
              totalMoved += Math.abs(event.dx) + Math.abs(event.dy);
              var newFrame = Math.round(xScale.invert(Math.max(0, Math.min(innerW, event.x))));
              newFrame = Math.max(0, Math.min(totalFrames - 1, newFrame));
              kf.frame = newFrame;
              state.currentFrame = newFrame;
              kfG.attr('transform', 'translate(' + xScale(newFrame) + ',' + kfMidY + ')');
              GC.renderCurrentFrame(); GC.movePlayhead(); GC.updatePlaybackUI();
            })
            .on('end', function (event) {
              if (totalMoved < 4) {
                var src = event.sourceEvent;
                if (src && src.type === 'touchend') {
                  showKfMenu(src.changedTouches[0].clientX, src.changedTouches[0].clientY, kf, ov);
                  return;
                }
              }
              GC.buildTimeline();
            })
          );

          kfG.on('contextmenu', function (event) {
            event.preventDefault(); event.stopPropagation();
            showKfMenu(event.clientX, event.clientY, kf, ov);
          });
        });
      });
    }

    // ── Playhead (vertical red line) ───────────
    var playhead = g.append('line')
      .attr('class', 'timeline-playhead')
      .attr('y1', 0)
      .attr('y2', numTracks * trackH + rulerH +
        (totalMotionTracks > 0 ? totalMotionTracks * trackH + 22 : 0))
      .attr('stroke', '#ef4444')
      .attr('stroke-width', 2)
      .attr('pointer-events', 'none');

    GC.timelineState = { xScale: xScale, playhead: playhead };
    GC.movePlayhead();
  };

  /** Move the playhead line to the current frame position. */
  GC.movePlayhead = function () {
    if (!GC.timelineState) return;
    var x = GC.timelineState.xScale(state.currentFrame);
    GC.timelineState.playhead.attr('x1', x).attr('x2', x);
  };

  // ── Keyframe context menu ─────────────────────
  // A single shared menu element; repositioned on each invocation.

  var _kfMenuKf  = null;  // keyframe object currently targeted
  var _kfMenuCap = null;  // caption or overlay that owns it

  function showKfMenu(clientX, clientY, kf, owner) {
    _kfMenuKf  = kf;
    _kfMenuCap = owner;
    var menu = document.getElementById('kf-context-menu');
    if (!menu) return;
    menu.classList.remove('hidden');
    // Position near the click/tap, keeping it inside the viewport
    var mw = 160, mh = 36;
    var x = Math.min(clientX + 4, window.innerWidth  - mw - 8);
    var y = Math.min(clientY + 4, window.innerHeight - mh - 8);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
  }

  function hideKfMenu() {
    var menu = document.getElementById('kf-context-menu');
    if (menu) menu.classList.add('hidden');
    _kfMenuKf  = null;
    _kfMenuCap = null;
  }

  // Wire up the remove button once (safe to call multiple times — idempotent via flag)
  GC.initKfMenu = function () {
    var btn = document.getElementById('kf-menu-remove');
    if (!btn || btn._kfMenuBound) return;
    btn._kfMenuBound = true;

    btn.addEventListener('click', function () {
      if (_kfMenuCap && _kfMenuKf) {
        _kfMenuCap.motion = _kfMenuCap.motion.filter(function (k) { return k !== _kfMenuKf; });
        hideKfMenu();
        GC.buildTimeline();
        GC.renderCurrentFrame();
        // Refresh sidebar if this caption/overlay is selected
        if (GC.state.selectedCaptionId === _kfMenuCap.id ||
            GC.state.selectedOverlayId === _kfMenuCap.id) GC.updateUI();
      }
    });

    // Dismiss on any outside click or touchstart
    document.addEventListener('pointerdown', function (e) {
      var menu = document.getElementById('kf-context-menu');
      if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) {
        hideKfMenu();
      }
    }, true);
  };

})();
