import React, { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

function computeOffsetRelativeToScrollParent(
  element: HTMLElement | null,
  scrollElement: HTMLElement | null
): number {
  if (!element || !scrollElement) return 0;
  let offset = 0;
  let current: HTMLElement | null = element;
  while (current && current !== scrollElement) {
    offset += current.offsetTop || 0;
    current = current.offsetParent as HTMLElement | null;
  }
  if (current === scrollElement) {
    return offset;
  }
  const elRect = element.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  return Math.max(0, Math.round(elRect.top - scrollRect.top + scrollElement.scrollTop));
}

function getDefaultInitialRect(): { width: number; height: number } {
  return {
    width: 960,
    height:
      typeof window !== 'undefined' && window.innerHeight > 0
        ? Math.max(420, Math.round(window.innerHeight * 0.68))
        : 640,
  };
}

export interface VirtualGridRowsProps<T> {
  items: readonly T[];
  scrollElement: HTMLElement | null;
  columnCount: number;
  estimatedRowHeight: number;
  overscan?: number;
  rowClassName: string;
  rowGapPx?: number;
  renderCard: (item: T, absoluteIndex: number) => React.ReactNode;
}

export function VirtualGridRows<T>({
  items,
  scrollElement,
  columnCount,
  estimatedRowHeight,
  overscan = 3,
  rowClassName,
  rowGapPx = 16,
  renderCard,
}: VirtualGridRowsProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const prevHeightRef = useRef<number>(0);
  const safeCols = Math.max(1, columnCount);
  const rowCount = Math.ceil(items.length / safeCols);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimatedRowHeight,
    overscan,
    scrollMargin,
    initialRect: getDefaultInitialRect(),
    useAnimationFrameWithResizeObserver: false,
  });

  const virtualizerRef = useRef(rowVirtualizer);
  virtualizerRef.current = rowVirtualizer;

  useLayoutEffect(() => {
    const syncMargin = () => {
      const next = computeOffsetRelativeToScrollParent(containerRef.current, scrollElement);
      setScrollMargin((prev) => (prev === next ? prev : next));
    };
    syncMargin();
    if (!scrollElement) {
      prevHeightRef.current = 0;
      return undefined;
    }
    const readHeight = () =>
      scrollElement.clientHeight || Math.round(scrollElement.getBoundingClientRect().height) || 0;
    prevHeightRef.current = readHeight();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      syncMargin();
      const nextHeight = readHeight();
      const wasZero = prevHeightRef.current <= 0;
      prevHeightRef.current = nextHeight;
      if (
        nextHeight > 0 &&
        (wasZero ||
          (virtualizerRef.current.options.count > 0 &&
            virtualizerRef.current.getVirtualItems().length === 0))
      ) {
        virtualizerRef.current.measure();
      }
    });
    ro.observe(scrollElement);
    return () => ro.disconnect();
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!scrollElement || rowCount <= 0) return;
    const currentHeight =
      scrollElement.clientHeight || Math.round(scrollElement.getBoundingClientRect().height) || 0;
    if (currentHeight > 0 && virtualizerRef.current.getVirtualItems().length === 0) {
      virtualizerRef.current.measure();
    }
  }, [scrollElement, rowCount]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const effectiveMargin = rowVirtualizer.options.scrollMargin ?? scrollMargin;

  return (
    <div
      ref={containerRef}
      data-testid="virtualized-grid-container"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {virtualRows.map((virtualRow) => {
        const startIdx = virtualRow.index * safeCols;
        const rowItems = items.slice(startIdx, startIdx + safeCols);
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - effectiveMargin}px)`,
              paddingBottom: `${rowGapPx}px`,
            }}
            className={rowClassName}
          >
            {rowItems.map((item, colIdx) => renderCard(item, startIdx + colIdx))}
          </div>
        );
      })}
    </div>
  );
}

export interface VirtualListRowsProps<T> {
  items: readonly T[];
  scrollElement: HTMLElement | null;
  estimatedItemHeight: number;
  estimateItemSize?: (item: T, index: number) => number;
  overscan?: number;
  itemGapPx?: number;
  itemClassName?: string;
  getItemKey?: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => React.ReactNode;
}

export function VirtualListRows<T>({
  items,
  scrollElement,
  estimatedItemHeight,
  estimateItemSize,
  overscan = 8,
  itemGapPx = 0,
  itemClassName,
  getItemKey,
  renderItem,
}: VirtualListRowsProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const prevHeightRef = useRef<number>(0);

  const listVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => {
      const item = items[index];
      if (estimateItemSize && item !== undefined) {
        return estimateItemSize(item, index);
      }
      return estimatedItemHeight;
    },
    overscan,
    scrollMargin,
    initialRect: getDefaultInitialRect(),
    useAnimationFrameWithResizeObserver: false,
    getItemKey: getItemKey ? (index) => getItemKey(items[index], index) : undefined,
  });

  const virtualizerRef = useRef(listVirtualizer);
  virtualizerRef.current = listVirtualizer;

  useLayoutEffect(() => {
    const syncMargin = () => {
      const next = computeOffsetRelativeToScrollParent(containerRef.current, scrollElement);
      setScrollMargin((prev) => (prev === next ? prev : next));
    };
    syncMargin();
    if (!scrollElement) {
      prevHeightRef.current = 0;
      return undefined;
    }
    const readHeight = () =>
      scrollElement.clientHeight || Math.round(scrollElement.getBoundingClientRect().height) || 0;
    prevHeightRef.current = readHeight();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      syncMargin();
      const nextHeight = readHeight();
      const wasZero = prevHeightRef.current <= 0;
      prevHeightRef.current = nextHeight;
      if (
        nextHeight > 0 &&
        (wasZero ||
          (virtualizerRef.current.options.count > 0 &&
            virtualizerRef.current.getVirtualItems().length === 0))
      ) {
        virtualizerRef.current.measure();
      }
    });
    ro.observe(scrollElement);
    return () => ro.disconnect();
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!scrollElement || items.length <= 0) return;
    const currentHeight =
      scrollElement.clientHeight || Math.round(scrollElement.getBoundingClientRect().height) || 0;
    if (currentHeight > 0 && virtualizerRef.current.getVirtualItems().length === 0) {
      virtualizerRef.current.measure();
    }
  }, [scrollElement, items.length]);

  const virtualItems = listVirtualizer.getVirtualItems();
  const effectiveMargin = listVirtualizer.options.scrollMargin ?? scrollMargin;

  return (
    <div
      ref={containerRef}
      data-testid="virtualized-list-container"
      style={{
        height: `${listVirtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (item === undefined) return null;
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={listVirtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start - effectiveMargin}px)`,
              paddingBottom: itemGapPx > 0 ? `${itemGapPx}px` : undefined,
            }}
            className={itemClassName}
          >
            {renderItem(item, virtualItem.index)}
          </div>
        );
      })}
    </div>
  );
}
