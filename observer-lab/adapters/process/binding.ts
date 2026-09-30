/** 文件职责：把 macOS Process Sensor 接入冻结 ObservationPlan 和只读 Binding。 */
import {
  digestValue,
  validateStableId,
  type ContentDigest,
  type SensorAdapterDescriptor,
} from "../../../src/core/models.js";
import {
  validateCaptureContext,
  type EnvironmentCaptureContext,
  type EnvironmentCaptureKind,
} from "../filesystem/binding.js";
import { FILE_SENSOR_DESCRIPTOR } from "../filesystem/binding.js";
import {
  captureProcessSnapshot,
  PROCESS_SENSOR_CAPABILITIES,
  PROCESS_SENSOR_CAPABILITY_DIGEST,
  PROCESS_SENSOR_IMPLEMENTATION_ID,
  PROCESS_SENSOR_IMPLEMENTATION_VERSION,
  type ProcessSnapshotDraft,
} from "./sensor.js";

export const PROCESS_SENSOR_DESCRIPTOR: SensorAdapterDescriptor = Object.freeze({
  implementationId: validateStableId<"SensorImplementationId">(PROCESS_SENSOR_IMPLEMENTATION_ID),
  implementationVersion: PROCESS_SENSOR_IMPLEMENTATION_VERSION,
  capabilityDigest: PROCESS_SENSOR_CAPABILITY_DIGEST,
  sourceType: "PROCESS",
  capabilities: PROCESS_SENSOR_CAPABILITIES,
});

export const ENVIRONMENT_SENSOR_REGISTRY_DIGEST: ContentDigest = digestValue([
  FILE_SENSOR_DESCRIPTOR,
  PROCESS_SENSOR_DESCRIPTOR,
]);

export interface ProcessCaptureContext extends EnvironmentCaptureContext {
  readonly observedUid: number;
}

export class ProcessEnvironmentSensor {
  public readonly descriptor = PROCESS_SENSOR_DESCRIPTOR;

  public captureBefore(context: ProcessCaptureContext): Promise<ProcessSnapshotDraft> {
    return this.capture("BEFORE", context);
  }

  public captureAfter(context: ProcessCaptureContext): Promise<ProcessSnapshotDraft> {
    return this.capture("AFTER", context);
  }

  public verifyReset(context: ProcessCaptureContext): Promise<ProcessSnapshotDraft> {
    return this.capture("POST_RESET", context);
  }

  private capture(kind: EnvironmentCaptureKind, context: ProcessCaptureContext): Promise<ProcessSnapshotDraft> {
    const { requirement } = validateCaptureContext(
      kind,
      context,
      this.descriptor,
      "PROCESS",
      false,
    );
    return captureProcessSnapshot({
      processSnapshotId: context.snapshotId,
      attemptId: context.attemptId,
      phase: kind,
      resourceBinding: requirement.resourceBinding,
      observedUid: context.observedUid,
      ...(context.now === undefined ? {} : { now: context.now }),
    });
  }
}
