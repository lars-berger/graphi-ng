import {
  Component,
  ChangeDetectionStrategy,
  Input,
  ContentChild,
  ElementRef,
  EventEmitter,
  QueryList,
  ViewChildren,
  ViewChild,
  Output,
  ChangeDetectorRef,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { curveBasis, CurveFactory, line } from 'd3-shape';
import * as dagre from 'dagre';
import { BehaviorSubject, fromEvent, merge, Observable, Subject } from 'rxjs';
import { map, switchMap, takeUntil } from 'rxjs/operators';
import { GraphDirection } from './models/graph-direction.model';

import { InputEdge } from './models/input-edge.model';
import { InputNode } from './models/input-node.model';
import { TransformedEdge } from './models/transformed-edge.model';
import { TransformedNode } from './models/transformed-node.model';
import { ViewBox } from './models/view-box.model';
import { DefsTemplateDirective, EdgeTemplateDirective, NodeTemplateDirective } from './templates';

@Component({
  selector: 'lib-graph',
  templateUrl: './graph.component.html',
  styleUrls: ['./graph.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphComponent<NData, EData> implements AfterViewInit, OnDestroy {
  /** The d3.curve used for defining the shape of edges. */
  @Input() curve: CurveFactory = curveBasis;

  /** Whether to enable zooming. */
  @Input() enableZooming: boolean = true;

  /** Whether to enable panning. */
  @Input() enablePanning: boolean = true;

  /** The speed of zooming in/out, if enabled. */
  @Input() zoomSpeed: number = 0.1;

  /** Whether to center the graph on any input changes. */
  @Input() centerOnChanges: boolean = false;

  /** The width of the graph (eg. '600px'). */
  @Input() width: string = '100%';

  /** The height of the graph (eg. '600px'). */
  @Input() height: string = '100%';

  /**
   * The direction of the graph layout. For example, using `GraphOrientation.LEFT_TO_RIGHT` in an
   * acyclic graph will cause edges to point from the left to the right.
   */
  @Input() direction: GraphDirection = GraphDirection.TOP_TO_BOTTOM;

  /** Number of pixels to use as a margin around the left and right of the graph. */
  @Input() marginX: number = 0;

  /** Number of pixels to use as a margin around the top and bottom of the graph. */
  @Input() marginY: number = 0;

  /** Event emitted when centering the graph. */
  @Output() readonly onCenter: EventEmitter<void> = new EventEmitter();

  /** Event emitted when zooming in/out of the graph. */
  @Output() readonly onZoom: EventEmitter<void> = new EventEmitter();

  /** Event emitted when the graph is being panned. */
  @Output() readonly onPan: EventEmitter<void> = new EventEmitter();

  /** Subject that emits when the component has been destroyed. */
  private readonly onDestroy$: Subject<void> = new Subject();

  @ContentChild(DefsTemplateDirective) defsTemplate: DefsTemplateDirective;
  @ContentChild(EdgeTemplateDirective) edgeTemplate: EdgeTemplateDirective<EData>;
  @ContentChild(NodeTemplateDirective) nodeTemplate: NodeTemplateDirective<NData>;

  @ViewChild('graphContainer') graphContainer: ElementRef<SVGSVGElement>;
  @ViewChild('nodesContainer') nodesContainer: ElementRef<SVGSVGElement>;
  @ViewChildren('node') nodeElements: QueryList<ElementRef>;

  /** The dimensions of the container SVG view box. */
  private viewBox$: BehaviorSubject<ViewBox> = new BehaviorSubject({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });

  get viewBox(): ViewBox {
    return this.viewBox$.value;
  }

  /** The SVG view box in a format that can be binded to in the template. */
  stringifiedViewBox$: Observable<string> = this.viewBox$.pipe(
    map((viewBox) => `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`),
  );

  transformedNodes: TransformedNode<NData>[] = [];
  transformedEdges: TransformedEdge<EData>[] = [];

  /** The array of nodes to display in the graph. */
  private get inputNodes(): InputNode<NData>[] {
    return this.nodeTemplate.inputNodes;
  }

  /** The array of edges to display in the graph. */
  private get inputEdges(): InputEdge<EData>[] {
    return this.edgeTemplate.inputEdges;
  }

  /** The curve interpolation function for edge lines. */
  private get curveInterpolationFn() {
    return line<{ x; y }>()
      .x((d) => d.x)
      .y((d) => d.y)
      .curve(this.curve);
  }

  constructor(private el: ElementRef<HTMLElement>, private cd: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    if (!this.edgeTemplate || !this.nodeTemplate) {
      throw new Error('Templates for nodes and edges are required.');
    }

    this.setInitialViewBox();

    this.renderGraph();

    if (this.enableZooming) {
      this.registerZoomListener();
    }

    if (this.enablePanning) {
      this.registerPanningListener();
    }

    if (this.centerOnChanges) {
      this.center();
    }

    const inputChanges$: Observable<void> = merge(
      this.edgeTemplate.onEdgeChanges$,
      this.nodeTemplate.onNodeChanges$,
    );

    // Re-render the graph on any changes to nodes or edges.
    inputChanges$.subscribe(() => {
      this.renderGraph();

      if (this.centerOnChanges) {
        this.center();
      }
    });
  }

  ngOnDestroy(): void {
    this.onDestroy$.next();
  }

  updateViewBox(viewBox: Partial<ViewBox>): void {
    this.viewBox$.next({
      ...this.viewBox$.value,
      ...viewBox,
    });
  }

  private setInitialViewBox(): void {
    // Get the container dimensions.
    const hostEl: HTMLElement = this.el.nativeElement;
    const hostDimensions: DOMRect = hostEl.getBoundingClientRect();

    this.updateViewBox({
      x: 0,
      y: 0,
      width: hostDimensions.width,
      height: hostDimensions.height,
    });
  }

  /** Render nodes and edges in the SVG viewbox. */
  renderGraph() {
    const graph: dagre.graphlib.Graph = this.createDagreGraph();

    // Update edges and nodes with layout information.
    dagre.layout(graph);

    const { edges, nodes } = dagre.graphlib.json.write(graph);

    this.transformedNodes = nodes.map((node) => {
      const inputNode: InputNode<NData> = this.getInputNode(node.v);
      const { width, height, x, y } = node.value;

      return {
        id: inputNode.id,
        width: width,
        height: height,
        x: x,
        y: y,
        transform: `translate(${x - width / 2}, ${y - height / 2})`,
        isVisible: true,
        data: {
          ...inputNode.data,
        },
      };
    });

    this.transformedEdges = edges.map((edge) => {
      const inputEdge: InputEdge<EData> = this.getInputEdge(edge.v, edge.w);

      return {
        id: inputEdge.id,
        sourceId: edge.v,
        targetId: edge.w,
        pathDefinition: this.curveInterpolationFn(edge.value.points),
        data: {
          ...inputEdge.data,
        },
      };
    });

    // Not sure why this is needed.
    this.cd.detectChanges();
  }

  private createDagreGraph(): dagre.graphlib.Graph {
    const graph = new dagre.graphlib.Graph();

    graph.setGraph({
      marginx: this.marginX,
      marginy: this.marginY,
      rankdir: this.direction,
      align: 'UL',
    });

    // Default to assigning a new object as a label for each new edge.
    graph.setDefaultEdgeLabel(() => ({}));

    this.renderNodesOffscreen();

    // The dimensions of every node needs to be known before passing it to the layout engine.
    for (let node of this.inputNodes) {
      const { width, height } = this.getNodeDimensions(node.id);

      graph.setNode(node.id, { width, height });
    }

    for (let edge of this.inputEdges) {
      graph.setEdge(edge.sourceId, edge.targetId);
    }

    return graph;
  }

  /** Get an input node by its ID. */
  private getInputNode(id: string) {
    return this.inputNodes.find((node) => node.id === id);
  }

  /** Get an input edge by its source ID and target ID. */
  private getInputEdge(sourceId: string, targetId: string) {
    return this.inputEdges.find((edge) => edge.sourceId === sourceId && edge.targetId === targetId);
  }

  private renderNodesOffscreen() {
    // The node width, height, x, and y values provided here are completely arbitrary. The point
    // is to render the nodes in the DOM to see what width/height they will actually take up and
    // later provide that to the layout engine.
    this.transformedNodes = this.inputNodes.map((node) => ({
      id: node.id,
      width: 1,
      height: 1,
      x: 0,
      y: 0,
      transform: '',
      isVisible: false,
      data: {
        ...node.data,
      },
    }));

    this.cd.detectChanges();
  }

  /** Get the dimensions of a node element. */
  private getNodeDimensions(nodeId: string): Readonly<{ width: number; height: number }> {
    // Query the DOM for the rendered node element.
    const nodeEl: ElementRef<SVGSVGElement> = this.nodeElements.find(
      (el) => el.nativeElement.id === nodeId,
    );

    const { width, height } = nodeEl.nativeElement.getBBox();
    return { width, height };
  }

  private registerZoomListener() {
    // Get zoom events on the SVG element.
    const svg: SVGSVGElement = this.graphContainer.nativeElement;
    const zoom$: Observable<WheelEvent> = fromEvent<WheelEvent>(svg, 'wheel').pipe(
      takeUntil(this.onDestroy$),
    );

    zoom$.subscribe((event: WheelEvent) => {
      // Prevent the page from scrolling as well.
      event.preventDefault();

      // Compute the zoom factor and zoom in/out accordingly.
      const zoomDirection: number = event.deltaY < 0 ? 1 : -1;
      const zoomFactor: number = Math.exp(zoomDirection * this.zoomSpeed);
      this.zoom(zoomFactor);

      // Get the X and Y coordinates of the pointer position.
      const { x: originX, y: originY } = this.getPointFromEvent(event);

      // Need to pan towards cursor when zooming in, and pan out when zooming out.
      const deltaX: number = (originX - this.viewBox.x) * (zoomFactor - 1);
      const deltaY: number = (originY - this.viewBox.y) * (zoomFactor - 1);
      this.pan(deltaX, deltaY);
    });
  }

  private registerPanningListener() {
    const svg: SVGSVGElement = this.graphContainer.nativeElement;

    // Get mouse events on the SVG element.
    const pointerdown$: Observable<MouseEvent> = fromEvent<MouseEvent>(svg, 'pointerdown');
    const pointermove$: Observable<MouseEvent> = fromEvent<MouseEvent>(document, 'pointermove');
    const pointerup$: Observable<MouseEvent> = fromEvent<MouseEvent>(document, 'pointerup');

    const pan$ = pointerdown$.pipe(
      switchMap((event: MouseEvent) => {
        // Get the X and Y coordinates of the original pointer position.
        const { x: originX, y: originY } = this.getPointFromEvent(event);

        return pointermove$.pipe(
          map((event: MouseEvent) => {
            // Prevent the pointer movement from doing a selection highlight on the page.
            event.preventDefault();

            // Get the X and Y coordinates of the updated pointer position.
            const { x: updatedX, y: updatedY } = this.getPointFromEvent(event);

            // Get the difference between the original and updated coordinates.
            const deltaX: number = updatedX - originX;
            const deltaY: number = updatedY - originY;

            return { deltaX, deltaY };
          }),
          takeUntil(pointerup$),
        );
      }),
      takeUntil(this.onDestroy$),
    );

    pan$.subscribe(({ deltaX, deltaY }) => {
      this.pan(deltaX, deltaY);
    });
  }

  /** Get the X and Y coordinates from a MouseEvent in the SVG container. */
  private getPointFromEvent(event: MouseEvent) {
    const svg: SVGSVGElement = this.graphContainer.nativeElement;

    // Create an SVG point.
    const point: DOMPoint = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;

    // We get the current transformation matrix of the SVG and we inverse it.
    const invertedSVGMatrix: DOMMatrix = svg.getScreenCTM().inverse();

    return point.matrixTransform(invertedSVGMatrix);
  }

  pan(deltaX: number, deltaY: number) {
    this.panX(deltaX);
    this.panY(deltaY);
  }

  panX(deltaX: number) {
    this.updateViewBox({ x: this.viewBox.x - deltaX });
    this.onPan.emit();
  }

  panY(deltaY: number) {
    this.updateViewBox({ y: this.viewBox.y - deltaY });
    this.onPan.emit();
  }

  panToCoordinates(x: number, y: number) {
    this.updateViewBox({ x, y });
    this.onPan.emit();
  }

  zoom(factor: number) {
    this.updateViewBox({
      width: this.viewBox.width * factor,
      height: this.viewBox.height * factor,
    });

    this.onZoom.emit();
  }

  center() {
    const boundingBox: DOMRect = this.nodesContainer.nativeElement.getBBox();

    const centerX: number = (boundingBox.x + boundingBox.width) / 2;
    const centerY: number = (boundingBox.y + boundingBox.height) / 2;

    const viewBoxCenterX: number = this.viewBox.width / 2;
    const viewBoxCenterY: number = this.viewBox.height / 2;

    // Pan to get the center point of the nodes in the middle of the view box.
    this.panToCoordinates(centerX - viewBoxCenterX, centerY - viewBoxCenterY);

    this.onCenter.emit();

    // Not sure why this is needed.
    this.cd.detectChanges();
  }

  /** Tracking for nodes and edges. */
  trackById(_index: number, object: any): string {
    return object.id;
  }
}
