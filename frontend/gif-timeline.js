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
    container.innerHTML = '';

    if (state.frames.length === 0) return;

    var totalFrames = state.frames.length;
    var trackH = 34;
    var rulerH = 28;
    var margin = { top: 8, right: 24, bottom: 4, left: 110 };
    var cw = container.clientWidth || 800;
    var innerW = cw - margin.left - margin.right;
    var numTracks = Math.max(state.captions.length, 0);
    var totalH = margin.top + numTracks * trackH + rulerH + margin.bottom;

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

    // ── Playhead (vertical red line) ───────────
    var playhead = g.append('line')
      .attr('class', 'timeline-playhead')
      .attr('y1', 0)
      .attr('y2', numTracks * trackH + rulerH)
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

})();
