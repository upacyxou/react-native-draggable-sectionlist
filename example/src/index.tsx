import React from 'react';
import {
  findNodeHandle,
  Platform,
  SectionList,
  SectionListProps,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import {
  GestureHandlerGestureEventNativeEvent,
  PanGestureHandler,
  PanGestureHandlerEventExtra,
  PanGestureHandlerGestureEvent,
  State as GestureState,
} from 'react-native-gesture-handler';
import Animated, {
  add,
  and,
  block,
  call,
  Clock,
  clockRunning,
  cond,
  defined,
  eq,
  event,
  greaterOrEq,
  greaterThan,
  lessOrEq,
  max,
  min,
  neq,
  not,
  onChange,
  or,
  set,
  spring,
  startClock,
  stopClock,
  sub,
  Value,
} from 'react-native-reanimated';
import {setupCell, springFill} from './procs';

const AnimatedSectionList = Animated.createAnimatedComponent(SectionList);

const defaultAnimationConfig = {
  damping: 20,
  mass: 0.2,
  stiffness: 100,
  overshootClamping: false,
  restSpeedThreshold: 0.2,
  restDisplacementThreshold: 0.2,
};

export type DragEndParams<T> = {
  data: T[];
  from: number;
  to: number;
};

export type RenderParams<T> = {
  item: T;
  index?: number; // This is technically a "last known index" since cells don't necessarily rerender when their index changes
  drag: () => void;
  isActive: boolean;
};

const defaultProps = {
  autoscrollThreshold: 30,
  autoscrollSpeed: 100,
  animationConfig: defaultAnimationConfig as Animated.SpringConfig,
  scrollEnabled: true,
  dragHitSlop: 0,
  activationDistance: 0,
  dragItemOverflow: false,
};

type DefaultProps = Readonly<typeof defaultProps>;

type AnimatedSectionListType<T> = {getNode: () => SectionList<T>};

type DataContent = {title: any; data: any[]};

type CellData = {
  size: Animated.Value<number>;
  offset: Animated.Value<number>;
  measurements: {
    size: number;
    offset: number;
  };
  style: Animated.AnimateProps<ViewStyle, {}>;
  currentIndex: Animated.Value<number>;
  onLayout: () => void;
  onUnmount: () => void;
};

type Modify<T, R> = Omit<T, keyof R> & R;
type Props<T> = Modify<
  SectionListProps<T>,
  {
    autoscrollSpeed?: number;
    autoscrollThreshold?: number;
    data: DataContent[];
    onRef?: (ref: React.RefObject<AnimatedSectionListType<T>>) => void;
    onDragBegin?: (index: number) => void;
    onRelease?: (index: number) => void;
    onDragEnd?: (params: DragEndParams<T>) => void;
    renderItem: (params: RenderParams<T>) => React.ReactNode;
    renderSectionHeader: (params: RenderParams<T>) => React.ReactNode;
    renderPlaceholder?: (params: {item: T; index: number}) => React.ReactNode;
    animationConfig: Partial<Animated.SpringConfig>;
    activationDistance?: number;
    debug?: boolean;
    layoutInvalidationKey?: string;
    onScrollOffsetChange?: (scrollOffset: number) => void;
    onPlaceholderIndexChange?: (placeholderIndex: number) => void;
    dragItemOverflow?: boolean;
  } & Partial<DefaultProps>
>;

type State = {
  activeKey: string | null;
  hoverComponent: React.ReactNode | null;
};

function onNextFrame(callback: () => void) {
  setTimeout(function () {
    requestAnimationFrame(callback);
  });
}

class DraggableSectionList<T> extends React.Component<Props<T>, State> {
  state: State = {
    activeKey: null,
    hoverComponent: null,
  };

  sectionListRef = React.createRef<AnimatedSectionListType<T>>();

  hoverTo = new Value(0);

  hoverAnimConfig = {
    ...defaultAnimationConfig,
    ...this.props.animationConfig,
    toValue: this.hoverTo,
  };

  constructor(props: Props<T>) {
    super(props);
    const {data, onRef} = props;
    let index = -1;
    data.forEach((item) => {
      index++;
      const titleKey = this.keyExtractor(item.title, index);
      this.keyToIndex.set(titleKey, index);
      item.data.forEach((dataItem) => {
        index++;
        const itemKey = this.keyExtractor(dataItem, index);
        this.keyToIndex.set(itemKey, index);
      });
    });
    onRef && onRef(this.sectionListRef);
  }

  isPressedIn = {
    native: new Value<number>(0),
    js: false,
  };

  touchAbsolute = new Value<number>(0);
  touchCellOffset = new Value<number>(0);

  containerSize = new Value<number>(0);

  hoverAnimUnconstrained = sub(this.touchAbsolute, this.touchCellOffset);

  activeIndex = new Value<number>(-1);
  activeCellSize = new Value<number>(0);
  spacerIndex = new Value<number>(-1);

  keyToIndex = new Map<string, number>();

  cellData = new Map<string, CellData>();
  cellRefs = new Map<string, React.RefObject<Animated.View>>();

  scrollOffset = new Value<number>(0);

  hoverAnimConstrained = min(
    sub(this.containerSize, this.activeCellSize),
    max(0, this.hoverAnimUnconstrained),
  );

  hoverAnim = this.props.dragItemOverflow
    ? this.hoverAnimUnconstrained
    : this.hoverAnimConstrained;

  hoverOffset = add(this.hoverAnim, this.scrollOffset);

  isHovering = greaterThan(this.activeIndex, -1);

  panGestureState = new Value(GestureState.UNDETERMINED);

  hasMoved = new Value(0);

  activationDistance = new Value<number>(0);

  disabled = new Value(0);
  placeholderOffset = new Value(0);

  queue: (() => void | Promise<void>)[] = [];

  cellAnim = new Map<
    string,
    {
      config: Animated.SpringConfig;
      state: Animated.SpringState;
      clock: Animated.Clock;
    }
  >();

  flushQueue = async () => {
    this.queue.forEach((fn) => fn());
    this.queue = [];
  };

  setCellData = (key: string, index: number) => {
    const clock = new Clock();
    const currentIndex = new Value(index);

    const config = {
      ...this.hoverAnimConfig,
      toValue: new Value(0),
    };

    const state = {
      position: new Value(0),
      velocity: new Value(0),
      time: new Value(0),
      finished: new Value(0),
    };

    this.cellAnim.set(key, {clock, state, config});

    const initialized = new Value(0);
    const size = new Value<number>(0);
    const offset = new Value<number>(0);
    const isAfterActive = new Value(0);
    const translate = new Value(0);

    const runSrping = cond(
      clockRunning(clock),
      springFill(clock, state, config),
    );
    const onHasMoved = startClock(clock);
    const onChangeSpacerIndex = cond(clockRunning(clock), stopClock(clock));
    const onFinished = stopClock(clock);

    const prevTrans = new Value(0);
    const prevSpacerIndex = new Value(-1);

    const anim = setupCell(
      currentIndex,
      initialized,
      size,
      offset,
      isAfterActive,
      translate,
      prevTrans,
      prevSpacerIndex,
      this.activeIndex,
      this.activeCellSize,
      this.hoverOffset,
      this.scrollOffset,
      this.isHovering,
      this.hoverTo,
      this.hasMoved,
      this.spacerIndex,
      config.toValue,
      state.position,
      state.time,
      state.finished,
      runSrping,
      onHasMoved,
      onChangeSpacerIndex,
      onFinished,
      this.isPressedIn.native,
      this.placeholderOffset,
    );

    const transform = this.props.horizontal
      ? [{translateX: anim}]
      : [{translateY: anim}];

    const style = {
      transform,
    };

    const cellData = {
      initialized,
      currentIndex,
      size,
      offset,
      style,
      onLayout: () => {
        if (this.state.activeKey !== key) this.measureCell(key);
      },
      onUnmount: () => initialized.setValue(0),
      measurements: {
        size: 0,
        offset: 0,
      },
    };
    this.cellData.set(key, cellData);
  };

  dataKeysHaveChanged = (a: any[], b: any[]) => {
    const lengthHasChanged = a.length !== b.length;
    if (lengthHasChanged) return true;
    let index = -1;
    const titleKeysA = a.map((d) => {
      index++;
      d.data.forEach(() => {
        index++;
      });
      return this.keyExtractor(d.title, index);
    });
    index = -1;
    const titleKeysB = b.map((d) => {
      index++;
      d.data.forEach(() => {
        index++;
      });
      return this.keyExtractor(d.title, index);
    });

    const titleSameKeys = titleKeysB.every((k) => titleKeysA.includes(k));

    return !titleSameKeys;
  };

  componentDidUpdate = async (prevProps: Props<T>, prevState: State) => {
    const layoutInvalidationKeyHasChanged =
      prevProps.layoutInvalidationKey !== this.props.layoutInvalidationKey;
    const dataHasChanged = prevProps.data !== this.props.data;
    if (layoutInvalidationKeyHasChanged || dataHasChanged) {
      let index = -1;
      this.props.data.forEach((item) => {
        index++;
        const titleKey = this.keyExtractor(item.title, index);
        this.keyToIndex.set(titleKey, index);
        item.data.forEach((dataItem) => {
          index++;
          const itemKey = this.keyExtractor(dataItem, index);
          this.keyToIndex.set(itemKey, index);
        });
      });
      // Remeasure on next paint
      this.updateCellData(this.props.data);
      onNextFrame(this.flushQueue);

      if (
        layoutInvalidationKeyHasChanged ||
        this.dataKeysHaveChanged(prevProps.data, this.props.data)
      ) {
        this.queue.push(() => this.measureAll(this.props.data));
      }
    }

    if (!prevState.activeKey && this.state.activeKey) {
      const index = this.keyToIndex.get(this.state.activeKey);
      if (index !== undefined) {
        this.spacerIndex.setValue(index);
        this.activeIndex.setValue(index);
        this.touchCellOffset.setValue(0);
        this.isPressedIn.native.setValue(1);
      }
      const cellData = this.cellData.get(this.state.activeKey);
      if (cellData) {
        this.touchAbsolute.setValue(sub(cellData.offset, this.scrollOffset));
        this.activeCellSize.setValue(cellData.measurements.size);
      }
    }
  };

  updateCellData = (data: any[] = []) => {
    let index = -1;
    data.forEach((item) => {
      index++;
      const titleKey = this.keyExtractor(item.title, index);
      const titleCell = this.cellData.get(titleKey);
      if (titleCell) titleCell.currentIndex.setValue(index);
      item.data.forEach((dataItem: any) => {
        index++;
        const itemKey = this.keyExtractor(dataItem, index);
        const itemCell = this.cellData.get(itemKey);
        if (itemCell) itemCell.currentIndex.setValue(index);
      });
    });
  };

  measureAll = (data: any[]) => {
    console.log('ох вау');
    let index = -1;
    data.forEach((item) => {
      index++;
      const titleKey = this.keyExtractor(item.title, index);
      this.measureCell(titleKey);
      item.data.forEach((dataItem: any) => {
        index++;
        const itemKey = this.keyExtractor(item, index);
        this.measureCell(itemKey);
      });
    });
  };

  measureCell = (key: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const {horizontal} = this.props;

      const onSuccess = (x: number, y: number, w: number, h: number) => {
        const {activeKey} = this.state;
        const isHovering = activeKey !== null;
        const cellData = this.cellData.get(key);
        const thisKeyIndex = this.keyToIndex.get(key);
        const activeKeyIndex = activeKey
          ? this.keyToIndex.get(activeKey)
          : undefined;
        const baseOffset = horizontal ? x : y;
        let extraOffset = 0;
        if (
          thisKeyIndex !== undefined &&
          activeKeyIndex !== undefined &&
          activeKey
        ) {
          const isAfterActive = thisKeyIndex > activeKeyIndex;
          const activeCellData = this.cellData.get(activeKey);
          if (isHovering && isAfterActive && activeCellData) {
            extraOffset = activeCellData.measurements.size;
          }
        }

        const size = horizontal ? w : h;
        const offset = baseOffset + extraOffset;

        console.log(
          `measure key ${key}: wdith ${w} height ${h} x ${x} y ${y} size ${size} offset ${offset}`,
        );

        if (cellData) {
          cellData.size.setValue(size);
          cellData.offset.setValue(offset);
          cellData.measurements.size = size;
          cellData.measurements.offset = offset;
        }

        // remeasure on next layout if hovering
        if (isHovering) this.queue.push(() => this.measureCell(key));
        resolve();
      };

      const onFail = () => {
        if (this.props.debug) console.log('## measureLayout fail!', key);
      };

      const ref = this.cellRefs.get(key);
      const viewNode = ref && ref.current && ref.current.getNode();
      const flatListNode =
        this.sectionListRef.current && this.sectionListRef.current.getNode();

      if (viewNode && flatListNode) {
        const nodeHandle = findNodeHandle(flatListNode);
        if (nodeHandle) viewNode.measureLayout(nodeHandle, onSuccess, onFail);
      } else {
        let reason = !ref
          ? 'no ref'
          : !flatListNode
          ? 'no flatlist node'
          : 'invalid ref';
        if (this.props.debug)
          console.log(`## can't measure ${key} reason: ${reason}`);
        this.queue.push(() => this.measureCell(key));
        return resolve();
      }
    });
  };

  keyExtractor = (item: T, index: number) => {
    if (this.props.keyExtractor) return this.props.keyExtractor(item, index);
    else
      throw new Error('You must provide a keyExtractor to DraggableFlatList');
  };

  drag = (hoverComponent: React.ReactNode, activeKey: string) => {
    if (this.state.hoverComponent) {
      console.error("Can't set multiple active items");
      return;
    }
    this.setState(
      {hoverComponent: hoverComponent, activeKey: activeKey},
      () => {
        const index = this.keyToIndex.get(activeKey);
        const {onDragBegin} = this.props;
        if (index !== undefined && onDragBegin) {
          onDragBegin(index);
        }
      },
    );
  };

  renderItem = ({item, index}: {item: T; index: number}) => {
    const key = this.keyExtractor(item, index);
    const {horizontal} = this.props;
    const {activeKey} = this.state;
    const {renderItem} = this.props;
    const {onUnmount} = this.cellData.get(key) || {
      onUnmount: () => {
        if (this.props.debug) console.log('## error, no cellData');
      },
    };

    if (index !== this.keyToIndex.get(key)) this.keyToIndex.set(key, index);
    if (!this.cellData.get(key)) this.setCellData(key, index);
    const cellData = this.cellData.get(key);
    if (!cellData) return null;
    let ref = this.cellRefs.get(key);
    if (!ref) {
      ref = React.createRef();
      this.cellRefs.set(key, ref);
    }
    const isActiveCell = activeKey === key;
    return (
      <Animated.View onLayout={cellData.onLayout} style={cellData.style}>
        <Animated.View
          pointerEvents={activeKey ? 'none' : 'auto'}
          style={{flexDirection: horizontal ? 'row' : 'column'}}>
          <Animated.View
            ref={ref}
            onLayout={cellData.onLayout}
            style={isActiveCell ? {opacity: 1} : undefined}>
            <RowItem
              extraData={this.props.extraData}
              itemKey={key}
              keyToIndex={this.keyToIndex}
              renderItem={renderItem}
              item={item}
              drag={this.drag}
              onUnmount={onUnmount}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    );
  };
  renderSectionHeader = () => {};

  onPanStateChange = event([
    {
      nativeEvent: ({
        state,
        x,
        y,
      }: GestureHandlerGestureEventNativeEvent & PanGestureHandlerEventExtra) =>
        cond(and(neq(state, this.panGestureState), not(this.disabled)), [
          set(this.panGestureState, state),
          cond(
            eq(this.panGestureState, GestureState.ACTIVE),
            set(
              this.activationDistance,
              sub(this.touchAbsolute, this.props.horizontal ? x : y),
            ),
          ),
          cond(
            or(
              eq(state, GestureState.END),
              eq(state, GestureState.CANCELLED),
              eq(state, GestureState.FAILED),
            ),
            this.onGestureRelease,
          ),
        ]),
    },
  ]);

  onPanGestureEvent = event([
    {
      nativeEvent: ({x, y}: PanGestureHandlerEventExtra) =>
        cond(
          and(
            this.isHovering,
            eq(this.panGestureState, GestureState.ACTIVE),
            not(this.disabled),
          ),
          [
            cond(not(this.hasMoved), set(this.hasMoved, 1)),
            set(
              this.touchAbsolute,
              add(this.props.horizontal ? x : y, this.activationDistance),
            ),
          ],
        ),
    },
  ]);

  renderOnPlaceholderIndexChange = () => (
    <Animated.Code>
      {() =>
        block([
          onChange(
            this.spacerIndex,
            call([this.spacerIndex], ([spacerIndex]) =>
              this.props.onPlaceholderIndexChange!(spacerIndex),
            ),
          ),
        ])
      }
    </Animated.Code>
  );

  placeholderPos = sub(this.placeholderOffset, this.scrollOffset);

  renderPlaceholder = () => {
    const {renderPlaceholder, horizontal}: any = this.props;
    const {activeKey} = this.state;
    if (!activeKey || !renderPlaceholder) return null;
    const activeIndex = this.keyToIndex.get(activeKey);
    if (activeIndex === undefined) return null;
    const activeItem = this.props.data[activeIndex];
    const translateKey = horizontal ? 'translateX' : 'translateY';
    const sizeKey = horizontal ? 'width' : 'height';
    const style = {
      ...StyleSheet.absoluteFillObject,
      [sizeKey]: this.activeCellSize,
      transform: [
        {[translateKey]: this.placeholderPos},
      ] as Animated.AnimatedTransform,
    };

    return (
      <Animated.View style={style}>
        {renderPlaceholder({item: activeItem, index: activeIndex})}
      </Animated.View>
    );
  };

  hoverComponentOpacity = and(
    this.isHovering,
    neq(this.panGestureState, GestureState.CANCELLED),
  );

  hoverClock = new Clock();

  hoverAnimState = {
    finished: new Value(0),
    velocity: new Value(0),
    position: new Value(0),
    time: new Value(0),
  };

  hoverComponentTranslate = cond(
    clockRunning(this.hoverClock),
    this.hoverAnimState.position,
    this.hoverAnim,
  );

  renderHoverComponent = () => {
    const {hoverComponent} = this.state;
    const {horizontal} = this.props;

    return (
      <Animated.View
        style={[
          horizontal
            ? styles.hoverComponentHorizontal
            : styles.hoverComponentVertical,
          {
            opacity: this.hoverComponentOpacity,
            transform: [
              {
                [`translate${horizontal ? 'X' : 'Y'}`]: this
                  .hoverComponentTranslate,
              },
              // We need the cast because the transform array usually accepts
              // only specific keys, and we dynamically generate the key
              // above
            ] as Animated.AnimatedTransform,
          },
        ]}>
        {hoverComponent}
      </Animated.View>
    );
  };

  onRelease = ([index]: readonly number[]) => {
    const {onRelease} = this.props;
    this.isPressedIn.js = false;
    onRelease && onRelease(index);
  };

  resetHoverState = () => {
    this.activeIndex.setValue(-1);
    this.spacerIndex.setValue(-1);
    this.disabled.setValue(0);
    if (this.state.hoverComponent !== null || this.state.activeKey !== null) {
      this.setState({
        hoverComponent: null,
        activeKey: null,
      });
    }
  };

  onGestureRelease = [
    cond(
      this.isHovering,
      [
        set(this.disabled, 1),
        cond(defined(this.hoverClock), [
          cond(clockRunning(this.hoverClock), stopClock(this.hoverClock)),
          set(this.hoverAnimState.position, this.hoverAnim),
          startClock(this.hoverClock),
        ]),
        [
          call([this.activeIndex], this.onRelease),
          cond(
            not(this.hasMoved),
            call([this.activeIndex], this.resetHoverState),
          ),
        ],
      ],
      call([this.activeIndex], this.resetHoverState),
    ),
  ];

  distToBottomEdge = max(
    0,
    sub(this.containerSize, add(this.hoverAnim, this.activeCellSize)),
  );

  isAtBottomEdge = lessOrEq(
    this.distToBottomEdge,
    this.props.autoscrollThreshold!,
  );

  distToTopEdge = max(0, this.hoverAnim);

  isAtTopEdge = lessOrEq(this.distToTopEdge, this.props.autoscrollThreshold!);

  isAtEdge = or(this.isAtBottomEdge, this.isAtTopEdge);

  isScrolledUp = lessOrEq(sub(this.scrollOffset, 2), 0);
  scrollViewSize = new Value<number>(0);

  isScrolledDown = greaterOrEq(
    add(this.scrollOffset, this.containerSize, 2),
    this.scrollViewSize,
  );

  isAutoscrolling = {
    native: new Value<number>(0),
    js: false,
  };

  autoscrollParams = [
    this.distToTopEdge,
    this.distToBottomEdge,
    this.scrollOffset,
    this.isScrolledUp,
    this.isScrolledDown,
  ];

  resolveAutoscroll?: (scrollParams: readonly number[]) => void;
  targetScrollOffset = new Value<number>(0);

  scrollToAsync = (offset: number): Promise<readonly number[]> =>
    new Promise((resolve, reject) => {
      this.resolveAutoscroll = resolve;
      this.targetScrollOffset.setValue(offset);
      this.isAutoscrolling.native.setValue(1);
      this.isAutoscrolling.js = true;
      const flatlistRef = this.sectionListRef.current;
      if (flatlistRef) flatlistRef.getNode();
    });

  getScrollTargetOffset = (
    distFromTop: number,
    distFromBottom: number,
    scrollOffset: number,
    isScrolledUp: boolean,
    isScrolledDown: boolean,
  ) => {
    if (this.isAutoscrolling.js) return -1;
    const {autoscrollThreshold, autoscrollSpeed} = this.props;
    const scrollUp = distFromTop < autoscrollThreshold!;
    const scrollDown = distFromBottom < autoscrollThreshold!;
    if (
      !(scrollUp || scrollDown) ||
      (scrollUp && isScrolledUp) ||
      (scrollDown && isScrolledDown)
    )
      return -1;
    const distFromEdge = scrollUp ? distFromTop : distFromBottom;
    const speedPct = 1 - distFromEdge / autoscrollThreshold!;
    // Android scroll speed seems much faster than ios
    const speed =
      Platform.OS === 'ios' ? autoscrollSpeed! : autoscrollSpeed! / 10;
    const offset = speedPct * speed;
    const targetOffset = scrollUp
      ? Math.max(0, scrollOffset - offset)
      : scrollOffset + offset;
    return targetOffset;
  };

  autoscrollLooping = false;
  autoscroll = async (params: readonly number[]) => {
    if (this.autoscrollLooping) {
      return;
    }
    this.autoscrollLooping = true;
    try {
      let shouldScroll = true;
      let curParams = params;
      while (shouldScroll) {
        const [
          distFromTop,
          distFromBottom,
          scrollOffset,
          isScrolledUp,
          isScrolledDown,
        ] = curParams;
        const targetOffset = this.getScrollTargetOffset(
          distFromTop,
          distFromBottom,
          scrollOffset,
          !!isScrolledUp,
          !!isScrolledDown,
        );
        const scrollingUpAtTop = !!(
          isScrolledUp && targetOffset <= scrollOffset
        );
        const scrollingDownAtBottom = !!(
          isScrolledDown && targetOffset >= scrollOffset
        );
        shouldScroll =
          targetOffset >= 0 &&
          this.isPressedIn.js &&
          !scrollingUpAtTop &&
          !scrollingDownAtBottom;

        if (shouldScroll) {
          curParams = await this.scrollToAsync(targetOffset);
        }
      }
    } finally {
      this.autoscrollLooping = false;
    }
  };

  checkAutoscroll = cond(
    and(
      this.isAtEdge,
      not(and(this.isAtTopEdge, this.isScrolledUp)),
      not(and(this.isAtBottomEdge, this.isScrolledDown)),
      eq(this.panGestureState, GestureState.ACTIVE),
      not(this.isAutoscrolling.native),
    ),
    call(this.autoscrollParams, this.autoscroll),
  );

  moveEndParams = [this.activeIndex, this.spacerIndex];

  onDragEnd = ([from, to]: readonly number[]) => {
    const {onDragEnd} = this.props;
    if (onDragEnd) {
      const {data}: any = this.props;
      let newData = [...data];
      if (from !== to) {
        newData.splice(from, 1);
        newData.splice(to, 0, data[from]);
      }

      onDragEnd({from, to, data: newData});
    }
  };

  resetHoverSpring = [
    set(this.hoverAnimState.time, 0),
    set(this.hoverAnimState.position, this.hoverAnimConfig.toValue),
    set(this.touchAbsolute, this.hoverAnimConfig.toValue),
    set(this.touchCellOffset, 0),
    set(this.hoverAnimState.finished, 0),
    set(this.hoverAnimState.velocity, 0),
    set(this.hasMoved, 0),
  ];
  render() {
    return (
      <PanGestureHandler
        onGestureEvent={this.onPanGestureEvent}
        onHandlerStateChange={this.onPanStateChange}>
        <Animated.View>
          {!!this.props.onPlaceholderIndexChange &&
            this.renderOnPlaceholderIndexChange()}
          {!!this.props.renderPlaceholder && this.renderPlaceholder()}
          <AnimatedSectionList
            sections={this.props.data}
            renderItem={this.renderItem}
            renderSectionHeader={() => <View></View>}
          />
          {!!this.state.hoverComponent && this.renderHoverComponent()}
          <Animated.Code>
            {() =>
              block([
                onChange(
                  this.isPressedIn.native,
                  cond(not(this.isPressedIn.native), this.onGestureRelease),
                ),
                onChange(this.touchAbsolute, this.checkAutoscroll),
                cond(clockRunning(this.hoverClock), [
                  spring(
                    this.hoverClock,
                    this.hoverAnimState,
                    this.hoverAnimConfig,
                  ),
                  cond(eq(this.hoverAnimState.finished, 1), [
                    stopClock(this.hoverClock),
                    call(this.moveEndParams, this.onDragEnd),
                    this.resetHoverSpring,
                    set(this.hasMoved, 0),
                  ]),
                ]),
              ])
            }
          </Animated.Code>
          {this.props.onScrollOffsetChange && (
            <Animated.Code>
              {() =>
                onChange(
                  this.scrollOffset,
                  call([this.scrollOffset], ([offset]) => (e: any) =>
                    console.log(e),
                  ),
                )
              }
            </Animated.Code>
          )}
        </Animated.View>
      </PanGestureHandler>
    );
  }
}

export default DraggableSectionList;

export type RenderItemParams<T> = {
  item: T;
  index?: number; // This is technically a "last known index" since cells don't necessarily rerender when their index changes
  drag: () => void;
  isActive: boolean;
};

type RowItemProps<T> = {
  extraData?: any;
  drag: (hoverComponent: React.ReactNode, itemKey: string) => void;
  keyToIndex: Map<string, number>;
  item: T;
  renderItem: (params: RenderItemParams<T>) => React.ReactNode;
  itemKey: string;
  onUnmount: () => void;
  debug?: boolean;
};

class RowItem<T> extends React.PureComponent<RowItemProps<T>> {
  drag = () => {
    const {drag, renderItem, item, keyToIndex, itemKey, debug} = this.props;
    const hoverComponent = renderItem({
      isActive: true,
      item,
      index: keyToIndex.get(itemKey),
      drag: () => {
        if (debug)
          console.log('## attempt to call drag() on hovering component');
      },
    });
    drag(hoverComponent, itemKey);
  };

  componentWillUnmount() {
    this.props.onUnmount();
  }

  render() {
    const {renderItem, item, keyToIndex, itemKey} = this.props;
    return renderItem({
      isActive: false,
      item,
      index: keyToIndex.get(itemKey),
      drag: this.drag,
    });
  }
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  hoverComponentVertical: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  hoverComponentHorizontal: {
    position: 'absolute',
    bottom: 0,
    top: 0,
  },
});
