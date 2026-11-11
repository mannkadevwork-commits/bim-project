/**
 * @deprecated Retired from the canonical room pipeline.
 *
 * Room identity and floor-map/ceiling boundaries are now derived by
 * RoomDetector -> RoomTopologyReconstructor. The retired global anchor
 * partitioner must not be reintroduced; anchor-based splitting is only valid
 * within an already connected, physically open-plan floor face.
 */
export const ROOM_ANCHOR_PARTITION_RETIRED = true as const;
