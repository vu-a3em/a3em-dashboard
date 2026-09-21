import { useId, useLayoutEffect, useRef, useState } from 'react';

export interface SeriesPoint {
  timestamp: string;
  value: number;
}

/**
 * A time series with labelled axes: the measured quantity up the left, time along the
 * bottom.
 *
 * Deliberately decimates rather than plotting every point — a months-long deployment
 * logs telemetry every five minutes, which is tens of thousands of samples for a chart a
 * few hundred pixels wide. Extremes survive the decimation, so a transient dip cannot be
 * averaged away.
 *
 * Over that long a span the whole trace is a smear, so dragging across it zooms to the
 * range dragged. Decimation then runs over the narrower slice, which is what actually
 * reveals detail: the same 300 plotted points now cover hours instead of months.
 */
export function TimeSeriesChart({
  points,
  color,
  unit,
  formatValue,
  timezone = 'UTC',
  height = 120,
}: Readonly<{
  points: SeriesPoint[];
  color: string;
  /** Shown on the y-axis, e.g. "V" or "°C". */
  unit: string;
  formatValue: (value: number) => string;
  /** IANA zone for the time axis, so a deployment reads in its own local time. */
  timezone?: string;
  height?: number;
}>) {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * The chart is drawn at its real pixel width rather than scaled from a fixed viewBox.
   *
   * A fixed viewBox with a constrained height scales to fit BOTH dimensions and centres
   * what is left, which left a full-width card holding a chart down the middle with dead
   * space either side. Measuring keeps one SVG unit to one pixel, so nothing is
   * distorted and the drag maps straight onto the axis.
   */
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const update = () => setMeasured(box.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Indices into `points`, not timestamps, so decimation and lookup stay cheap.
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  /**
   * A zoom belongs to the series it was drawn on.
   *
   * `range` holds absolute indices into `points`. When the caller swaps the series —
   * changing the activation filter, say — those indices address a different run, and
   * slicing the new array with them either lands on the wrong window or falls off the
   * end entirely, leaving the chart showing everything while the footer still claims a
   * zoom. Dropping the zoom when the data changes underneath is the honest behaviour.
   */
  const identity = `${points.length}|${points[0]?.timestamp ?? ''}|${points[points.length - 1]?.timestamp ?? ''}`;
  const [zoomedFor, setZoomedFor] = useState(identity);
  const stale = zoomedFor !== identity;
  if (stale) {
    setZoomedFor(identity);
    if (range) setRange(null);
    if (drag) setDrag(null);
  }
  // Setting state during render does NOT abort this pass — the rest of the function
  // still runs with the old value — so the zoom has to be dropped locally as well, or
  // this render slices the new series with the previous one's indices.
  const zoom = stale ? null : range;

  if (points.length < 2) {
    return <p className="muted">Not enough samples to plot.</p>;
  }

  // A slice that came back too short to plot falls back to the whole series, and the
  // axis labels read from what is actually drawn — never from an empty slice.
  const sliced = zoom ? points.slice(zoom.from, zoom.to + 1) : points;
  const visible = sliced.length >= 2 ? sliced : points;
  const series = decimate(visible, 300);
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  // Room on the left for value labels and along the bottom for dates
  const width = Math.max(320, measured || 520);
  const gutterLeft = 46;
  const gutterBottom = 20;
  const padTop = 8;
  const plotWidth = width - gutterLeft;
  const plotHeight = height - gutterBottom - padTop;

  const x = (index: number) => gutterLeft + (index / (series.length - 1)) * plotWidth;
  const y = (value: number) => padTop + (1 - (value - min) / span) * plotHeight;

  // The visible span, as absolute indices into `points`. Both the pointer mapping and
  // the selection rectangle go through it, so a chart that is already zoomed cannot end
  // up drawing against the full series while reading against the zoomed one.
  const spanFrom = zoom ? zoom.from : 0;
  const spanTo = zoom ? zoom.to : points.length - 1;
  const spanCount = Math.max(1, spanTo - spanFrom);

  /** Where an absolute index sits across the visible span, 0 to 1. */
  const fractionOf = (index: number) => (index - spanFrom) / spanCount;

  /** Absolute index in `points` under a client x position. */
  const indexAt = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const withinPlot = ((clientX - rect.left) / rect.width) * width - gutterLeft;
    const fraction = Math.max(0, Math.min(1, withinPlot / plotWidth));
    return spanFrom + Math.round(fraction * spanCount);
  };

  const line = series
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`)
    .join(' ');
  const area = `${line} L${width},${padTop + plotHeight} L${gutterLeft},${padTop + plotHeight} Z`;

  const midpoint = min + span / 2;
  const ticks = [max, midpoint, min];

  return (
    <div ref={boxRef} style={drag ? { userSelect: 'none' } : undefined}>
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={
        `${unit} from ${formatValue(points[0].value)} to ${formatValue(points.at(-1)!.value)}, ` +
        `between ${shortDate(visible[0].timestamp, timezone)} and ${shortDate(visible.at(-1)!.timestamp, timezone)}`
      }
      ref={svgRef}
      style={{ overflow: 'visible', cursor: 'col-resize', touchAction: 'none' }}
      onPointerDown={(event) => {
        // Without this the drag also sweeps a text selection through the labels below.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = indexAt(event.clientX);
        setDrag({ from: at, to: at });
      }}
      onPointerMove={(event) => {
        if (drag) setDrag({ ...drag, to: indexAt(event.clientX) });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const from = Math.min(drag.from, drag.to);
        const to = Math.max(drag.from, drag.to);
        // A click rather than a drag should not collapse the chart to nothing.
        if (to - from >= 2) setRange({ from, to });
        setDrag(null);
      }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.24" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Horizontal guides, with the measured quantity labelled up the left */}
      {ticks.map((value) => (
        <g key={value}>
          <line
            x1={gutterLeft}
            x2={width}
            y1={y(value)}
            y2={y(value)}
            stroke="var(--line)"
            strokeWidth="1"
            strokeDasharray={value === min || value === max ? undefined : '3 3'}
          />
          <text
            x={gutterLeft - 7}
            y={y(value)}
            textAnchor="end"
            dominantBaseline="middle"
            fill="var(--ink-3)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {formatValue(value)}
          </text>
        </g>
      ))}

      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={x(series.length - 1)} cy={y(series.at(-1)!.value)} r="2.8" fill={color} />

      {/* The range being dragged, drawn over the trace so the selection is visible */}
      {drag && Math.abs(drag.to - drag.from) >= 2 ? (
        <rect
          x={gutterLeft + fractionOf(Math.min(drag.from, drag.to)) * plotWidth}
          width={(fractionOf(Math.max(drag.from, drag.to)) - fractionOf(Math.min(drag.from, drag.to))) * plotWidth}
          y={padTop}
          height={plotHeight}
          fill={color}
          fillOpacity="0.16"
        />
      ) : null}

      {/* Time along the bottom */}
      <text x={gutterLeft} y={height - 5} fill="var(--ink-3)" fontSize="10" fontFamily="var(--font-mono)">
        {shortDate(visible[0].timestamp, timezone)}
      </text>
      <text
        x={gutterLeft + plotWidth / 2}
        y={height - 5}
        textAnchor="middle"
        fill="var(--ink-3)"
        fontSize="10"
        fontFamily="var(--font-mono)"
      >
        {unit}
      </text>
      <text x={width} y={height - 5} textAnchor="end" fill="var(--ink-3)" fontSize="10" fontFamily="var(--font-mono)">
        {shortDate(visible.at(-1)!.timestamp, timezone)}
      </text>
    </svg>
    <div className="chart-foot">
      <span>{zoom ? `${series.length.toLocaleString()} of ${points.length.toLocaleString()} samples shown` : 'Drag across the chart to zoom'}</span>
      {zoom ? (
        <button className="btn small ghost" onClick={() => setRange(null)}>
          Reset zoom to whole deployment
        </button>
      ) : null}
    </div>
    </div>
  );
}

/**
 * A short axis label in the deployment's own timezone.
 *
 * Reading a dawn-chorus trace against UTC means mentally shifting every tick, so the
 * axis follows the zone the schedule was written in.
 */
/**
 * An axis label, in the reader's own conventions.
 *
 * Year dropped: the axis spans days at most, and the deployment's dates are stated above
 * it. Everything else follows the locale, so a page that says 6:00 PM everywhere else
 * does not say 18:00 here.
 */
function shortDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}


/** Reduces to at most `target` points, keeping each bucket's extremes in time order. */
function decimate(points: SeriesPoint[], target: number): SeriesPoint[] {
  if (points.length <= target) return points;
  const bucketSize = Math.ceil(points.length / (target / 2));
  const out: SeriesPoint[] = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, start + bucketSize);
    let lowest = bucket[0];
    let highest = bucket[0];
    for (const point of bucket) {
      if (point.value < lowest.value) lowest = point;
      if (point.value > highest.value) highest = point;
    }
    // Emit in the order they occurred, so the line does not zigzag artificially
    const [first, second] =
      bucket.indexOf(lowest) <= bucket.indexOf(highest) ? [lowest, highest] : [highest, lowest];
    out.push(first);
    if (second !== first) out.push(second);
  }
  return out;
}
