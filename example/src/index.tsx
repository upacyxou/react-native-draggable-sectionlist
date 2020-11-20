import React from 'react';
import {
  findNodeHandle,
  SectionList,
  SectionListData,
  SectionListProps,
  SectionListRenderItemInfo,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import Animated, {
  add,
  Clock,
  clockRunning,
  cond,
  greaterThan,
  max,
  min,
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

type sectionValue = {
  data: any[];
  section: any[];
};

export type RenderItemParams<T> = {
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

type AnimatedFlatListType<T> = {getNode: () => SectionList<T>};

export type RenderSectionHeaderParams<T> = {
  section: T;
  index?: number; // This is technically a "last known index" since cells don't necessarily rerender when their index changes
  drag: () => void;
  isActive: boolean;
};
type State = {
  activeKey: string | null;
  hoverComponent: React.ReactNode | null;
};

type Modify<T, R> = Omit<T, keyof R> & R;
type Props<T> = Modify<
  SectionListProps<T>,
  {
    onDragBegin?: (index: number) => void;
    sections: sectionValue[];
    renderItem: (params: RenderItemParams<T>) => React.ReactNode;
    renderSectionHeader: (
      params: RenderSectionHeaderParams<T>,
    ) => React.ReactNode;
    isSectionHeader: (itemForCheck: any) => boolean;
    animationConfig: Partial<Animated.SpringConfig>;
    dragItemOverflow?: boolean;
  } & Partial<DefaultProps>
>;

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

class DraggableSectionList<T> extends React.Component<Props<T>> {
  headersAndData: any[] = [];

  flatlistRef = React.createRef<AnimatedFlatListType<T>>();

  keyToIndex = new Map<string, number>();
  cellData = new Map<string, CellData>();
  cellRefs = new Map<string, React.RefObject<Animated.View>>();

  containerSize = new Value<number>(0);

  touchAbsolute = new Value<number>(0);
  touchCellOffset = new Value<number>(0);
  hoverTo = new Value(0);

  isPressedIn = {
    native: new Value<number>(0),
    js: false,
  };

  activeCellSize = new Value<number>(0);
  scrollOffset = new Value<number>(0);
  hoverAnimUnconstrained = sub(this.touchAbsolute, this.touchCellOffset);
  hoverAnimConstrained = min(
    sub(this.containerSize, this.activeCellSize),
    max(0, this.hoverAnimUnconstrained),
  );

  hoverAnim = this.props.dragItemOverflow
    ? this.hoverAnimUnconstrained
    : this.hoverAnimConstrained;

  activeIndex = new Value<number>(-1);
  hasMoved = new Value(0);
  hoverOffset = add(this.hoverAnim, this.scrollOffset);

  spacerIndex = new Value<number>(-1);

  isHovering = greaterThan(this.activeIndex, -1);

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

  hoverAnimConfig = {
    ...defaultAnimationConfig,
    ...this.props.animationConfig,
    toValue: this.hoverTo,
  };

  constructor(props: Props<T>) {
    super(props);
    const {sections} = props;
    sections.forEach((item) => {
      this.headersAndData = [...this.headersAndData, item.section];
      item.data.forEach((dataItem) => {
        this.headersAndData = [...this.headersAndData, dataItem];
      });
    });
    this.headersAndData.forEach((dataOrHeader, index) => {
      const key = this.keyExtractor(dataOrHeader, index);
      this.keyToIndex.set(key, index);
    });
  }

  state: State = {
    activeKey: null,
    hoverComponent: null,
  };

  keyExtractor = (item: T, index: number) => {
    if (this.props.keyExtractor) return this.props.keyExtractor(item, index);
    else
      throw new Error('You must provide a keyExtractor to DraggableFlatList');
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

        if (cellData) {
          cellData.size.setValue(size);
          cellData.offset.setValue(offset);
          cellData.measurements.size = size;
          cellData.measurements.offset = offset;
        }

        if (isHovering) this.queue.push(() => this.measureCell(key));
        resolve();
      };

      const onFail = () => {
        console.log('failed measure layout');
      };

      const ref = this.cellRefs.get(key);
      const viewNode = ref && ref.current && ref.current.getNode();
      const flatListNode =
        this.flatlistRef.current && this.flatlistRef.current.getNode();
      if (viewNode && flatListNode) {
        const nodeHandle = findNodeHandle(flatListNode);
        if (nodeHandle) viewNode.measureLayout(nodeHandle, onSuccess, onFail);
      } else {
        this.queue.push(() => this.measureCell(key));
        return resolve();
      }
    });
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

    const onHasMoved = startClock(clock);
    const onChangeSpacerIndex = cond(clockRunning(clock), stopClock(clock));
    const onFinished = stopClock(clock);

    const prevTrans = new Value(0);
    const prevSpacerIndex = new Value(-1);

    const runSrping = cond(
      clockRunning(clock),
      springFill(clock, state, config),
    );

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
    const style = {transform};

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

  drag = (hoverComponent: React.ReactNode, activeKey: string) => {
    if (this.state.hoverComponent) {
      // We can't drag more than one row at a time
      // TODO: Put action on queue?
      if (this.props.debug) console.log("## Can't set multiple active items");
    } else {
      this.isPressedIn.js = true;

      this.setState(
        {
          activeKey,
          hoverComponent,
        },
        () => {
          const index = this.keyToIndex.get(activeKey);
          const {onDragBegin} = this.props;
          if (index !== undefined && onDragBegin) {
            onDragBegin(index);
          }
        },
      );
    }
  };

  renderItem = (item: RenderItemParams<T>) => {
    const index = this.headersAndData.indexOf(item.item);
    const key = this.keyExtractor(item.item, index);
    const {activeKey} = this.state;
    const {horizontal} = this.props;
    if (index !== this.keyToIndex.get(key)) this.keyToIndex.set(key, index);
    if (!this.cellData.get(key)) this.setCellData(key, index);
    let ref = this.cellRefs.get(key);
    if (!ref) {
      ref = React.createRef();
      this.cellRefs.set(key, ref);
    }
    const {onUnmount} = this.cellData.get(key) || {
      onUnmount: () => {
        if (this.props.debug) console.log('## error, no cellData');
      },
    };
    const cellData = this.cellData.get(key);
    if (!cellData) return null;
    const {style, onLayout: onCellLayout} = cellData;
    const isActiveCell = activeKey === key;
    return (
      <Animated.View style={style}>
        <Animated.View
          pointerEvents={activeKey ? 'none' : 'auto'}
          style={{
            flexDirection: horizontal ? 'row' : 'column',
          }}>
          <Animated.View
            ref={ref}
            onLayout={onCellLayout}
            style={isActiveCell ? {opacity: 0} : undefined}>
            {this.props.renderItem(item)}
            <RowItem
              extraData={this.props.extraData}
              itemKey={key}
              keyToIndex={this.keyToIndex}
              renderItem={this.props.renderItem}
              item={item}
              drag={this.drag}
              onUnmount={onUnmount}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    );
  };

  renderSectionHeader = (info: SectionListData<T>) => {
    const index = this.headersAndData.indexOf(info.section.section);
    const {activeKey} = this.state;
    const key = this.keyExtractor(info.section.section, index);
    if (index !== this.keyToIndex.get(key)) this.keyToIndex.set(key, index);
    if (!this.cellData.get(key)) this.setCellData(key, index);
    let ref = this.cellRefs.get(key);
    if (!ref) {
      ref = React.createRef();
      this.cellRefs.set(key, ref);
    }
    const {onUnmount} = this.cellData.get(key) || {
      onUnmount: () => {
        if (this.props.debug) console.log('## error, no cellData');
      },
    };
    const cellData = this.cellData.get(key);
    if (!cellData) return null;
    const {horizontal} = this.props;
    const isActiveCell = activeKey === key;
    const {style, onLayout: onCellLayout} = cellData;
    const children = this.props.renderSectionHeader!(info.section);
    return (
      <Animated.View style={style}>
        <Animated.View
          pointerEvents={activeKey ? 'none' : 'auto'}
          style={{
            flexDirection: horizontal ? 'row' : 'column',
          }}>
          <Animated.View
            ref={ref}
            onLayout={onCellLayout}
            style={isActiveCell ? {opacity: 0} : undefined}>
            {children}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    );
  };

  render() {
    return (
      <AnimatedSectionList
        ref={this.flatlistRef}
        sections={this.props.sections}
        renderItem={this.renderItem}
        renderSectionHeader={this.renderSectionHeader}
      />
    );
  }
}

export default DraggableSectionList;

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
