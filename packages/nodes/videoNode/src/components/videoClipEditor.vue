<template>
  <div class="videoClipEditor nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.capture="handleKeydown" @keydown.stop>
    <p v-if="preparingPreview || previewError" class="previewStatus" role="status">{{ preparingPreview ? "正在生成兼容预览…" : previewError }}</p>
    <video
      ref="preview"
      class="editorPreview"
      :class="{ unavailable: disabled }"
      :src="src"
      controls
      playsinline
      preload="auto"
      :inert="disabled"
      aria-label="视频剪辑预览"
      @loadedmetadata="readMetadata"
      @timeupdate="updatePlayback"
      @play="startPlayback"
      @ended="pause" />
    <div class="clipTimeline" :class="{ unavailable: disabled || !duration }">
      <div class="timelineHeader">
        <span>点击片段选中，游标处分割；删除的片段导出时会跳过</span>
        <span class="sourceDuration">原视频 {{ formatTime(duration) }} · 成片 {{ formatTime(totalDuration) }}</span>
      </div>
      <div class="timelineBody">
        <div ref="trackArea" class="editorTrack">
          <div class="timeRuler" @click="seekTimeline">
            <span v-for="tick in 6" :key="tick" :style="{ left: `${(tick - 1) * 20}%` }">{{ formatTime((tick - 1) * timelineDuration / 5) }}</span>
          </div>
          <div class="segmentTrack" role="group" aria-label="视频剪辑轨道">
            <button
              v-for="(clip, index) in clips"
              :key="index"
              class="segmentItem"
              :class="{ selected: selectedIndex === index }"
              type="button"
              :disabled="disabled"
              :aria-pressed="selectedIndex === index"
              :aria-label="`片段 ${index + 1}，时长 ${clip.length.toFixed(2)} 秒`"
              @click="selectSegment(index, $event)"
              @keydown.left.prevent="seekAt(playhead - 0.1)"
              @keydown.right.prevent="seekAt(playhead + 0.1)"
              @keydown.delete.prevent="selectedIndex = index; removeSegment()">
              <span class="segmentName">片段 {{ index + 1 }}</span>
              <span class="segmentRange">{{ formatTime(clip.start) }} – {{ formatTime(clip.end) }}</span>
              <span class="segmentDuration">{{ clip.length.toFixed(2) }} 秒</span>
            </button>
          </div>
          <span v-if="segments.length" class="playhead" :style="{ left: `${playhead / timelineDuration * 100}%` }" aria-hidden="true" />
          <input class="cursorInput" type="range" min="0" :max="totalDuration || 1" step="0.01" :value="playhead" :disabled="disabled || !valid" aria-label="剪辑游标" :aria-valuetext="`${formatTime(playhead)} / ${formatTime(totalDuration)}`" @pointerdown.stop @input="seekCursor" />
        </div>
        <div class="timeRuler" aria-hidden="true"><span v-for="index in 5" :key="index">{{ formatTime(duration * (index - 1) / 4) }}</span></div>
      </div>
    </div>
    <div class="editActions">
      <el-button :icon="IconArrowBackUp" :disabled="disabled || !undoStack.length" title="撤销（Ctrl+Z）" @click="undo">撤销</el-button>
      <el-button :icon="IconArrowForwardUp" :disabled="disabled || !redoStack.length" title="恢复（Ctrl+Y）" @click="redo">恢复</el-button>
      <el-button :icon="IconScissors" :disabled="disabled || !canSplit" @click="splitSegment">分割</el-button>
      <el-button :icon="IconLink" :disabled="disabled || !canMerge" :title="selectedIndex > 0 ? '与前一片段粘合' : '与后一片段粘合'" @click="mergeSegment">粘合</el-button>
      <el-button :icon="IconTrash" :disabled="disabled || !activeSegment" @click="removeSegment">删除选中片段</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { IconArrowBackUp, IconArrowForwardUp, IconLink, IconScissors, IconTrash } from "@tabler/icons-vue";
import type { VideoSegment } from "../videoProcessing";

type EditState = { groups: VideoSegment[][]; selectedIndex: number; playhead: number };
const props = defineProps<{ src: string; disabled?: boolean }>();
const segments = defineModel<VideoSegment[]>({ required: true });
const preview = ref<HTMLVideoElement>();
const duration = ref(0);
const selectedIndex = ref(0);
const playhead = ref(0);
const trackArea = ref<HTMLDivElement>();
// ACT: 分组只用于编辑器的粘合显示，导出仍展开为原始区间，保留删除造成的缺口。
const groups = ref<VideoSegment[][]>([]);
const undoStack = ref<EditState[]>([]);
const redoStack = ref<EditState[]>([]);
const activeSegment = computed(() => groups.value[selectedIndex.value]);
const clips = computed(() => {
  let offset = 0;
  return groups.value.map(ranges => {
    const start = ranges[0]!.start;
    const end = ranges[ranges.length - 1]!.end;
    const length = ranges.reduce((total, range) => total + range.end - range.start, 0);
    const clip = { start, end, offset, length };
    offset += length;
    return clip;
  });
});
const totalDuration = computed(() => clips.value.reduce((total, clip) => total + clip.length, 0));
const timelineDuration = computed(() => totalDuration.value || duration.value || 1);
const valid = computed(() => !!duration.value && groups.value.length > 0
  && groups.value.flat().every(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.start >= 0 && segment.end > segment.start && segment.end <= duration.value));
const canSplit = computed(() => {
  const clip = clips.value[selectedIndex.value];
  return clip && playhead.value - clip.offset >= 0.01 && clip.offset + clip.length - playhead.value >= 0.01;
});
const canMerge = computed(() => !!activeSegment.value && groups.value.length > 1);
let playbackClipIndex = 0;
let seeking = false;

watch(() => props.src, () => {
  duration.value = 0;
  undoStack.value = redoStack.value = [];
  applyState({ groups: [], selectedIndex: 0, playhead: 0 });
});
watch(() => props.disabled, value => { if (value) pause(); });
watch(() => preview.value, element => {
  if (!element) return;
  const value = element.duration;
  if (Number.isFinite(value) && value > 0) readDurationValue(value);
});
onBeforeUnmount(pause);
defineExpose({ valid, pause });

function formatTime(value: number) {
  const safe = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 100);
  return `${Math.floor(safe / 6000)}:${(safe % 6000 / 100).toFixed(2).padStart(5, "0")}`;
}

function pause() {
  preview.value?.pause();
}

function readMetadata(event: Event) {
  const value = (event.currentTarget as HTMLVideoElement).duration;
  readDurationValue(Number.isFinite(value) && value > 0 ? value : 0);
}

function readDurationValue(value: number) {
  duration.value = value;
  if (duration.value && !groups.value.length) {
    const ranges = segments.value.length ? segments.value : [{ start: 0, end: duration.value }];
    applyState({ groups: ranges.map(range => [{ ...range }]), selectedIndex: 0, playhead: 0 });
  }
}

function snapshot(): EditState {
  return { groups: groups.value.map(group => group.map(range => ({ ...range }))), selectedIndex: selectedIndex.value, playhead: playhead.value };
}

function applyState(state: EditState) {
  pause();
  groups.value = state.groups;
  segments.value = state.groups.flat().map(range => ({ ...range }));
  playhead.value = Math.min(totalDuration.value, Math.max(0, state.playhead));
  seekPlayer();
  selectedIndex.value = state.selectedIndex;
}

function commit(next: VideoSegment[][], index: number, time = playhead.value) {
  undoStack.value.push(snapshot());
  redoStack.value = [];
  applyState({ groups: next, selectedIndex: index, playhead: time });
}

function undo() {
  if (props.disabled || !undoStack.value.length) return;
  redoStack.value.push(snapshot());
  applyState(undoStack.value.pop()!);
}

function redo() {
  if (props.disabled || !redoStack.value.length) return;
  undoStack.value.push(snapshot());
  applyState(redoStack.value.pop()!);
}

function handleKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== "z" && key !== "y") return;
  event.preventDefault();
  if (key === "y" || event.shiftKey) redo();
  else undo();
}

function selectSegment(index: number, event?: MouseEvent) {
  const clip = clips.value[index];
  if (props.disabled || !clip) return;
  let time = clip.offset;
  if (event?.detail) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    time += clip.length * Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }
  seekAt(time);
}

function seekTimeline(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  seekAt((event.clientX - rect.left) / rect.width * timelineDuration.value);
}

function seekCursor(event: Event) {
  seekAt((event.target as HTMLInputElement).valueAsNumber);
}

function seekAt(time: number) {
  if (props.disabled || !Number.isFinite(time)) return;
  pause();
  playhead.value = Math.min(totalDuration.value, Math.max(0, time));
  seekPlayer();
}

function seekPlayer() {
  const index = clips.value.findIndex(clip => clip.offset + clip.length > playhead.value);
  selectedIndex.value = playbackClipIndex = index < 0 ? Math.max(0, clips.value.length - 1) : index;
  const clip = clips.value[playbackClipIndex];
  if (!clip || !preview.value) return;
  seeking = true;
  preview.value.currentTime = Math.min(Math.max(0, duration.value - 0.001), Math.max(0, clip.start + playhead.value - clip.offset));
}

function splitSegment() {
  const clip = clips.value[selectedIndex.value];
  if (props.disabled || !canSplit.value || !clip) return;
  const sourceTime = clip.start + playhead.value - clip.offset;
  const next = [...groups.value];
  next.splice(selectedIndex.value, 1,
    [{ start: clip.start, end: sourceTime }],
    [{ start: sourceTime, end: clip.end }]);
  commit(next, selectedIndex.value + 1);
}

function mergeSegment() {
  if (props.disabled || !canMerge.value) return;
  const index = Math.max(0, selectedIndex.value - 1);
  const next = [...groups.value];
  next.splice(index, 2, [...next[index]!, ...next[index + 1]!]);
  commit(next, index);
}

function removeSegment() {
  if (props.disabled || !activeSegment.value) return;
  const next = groups.value.filter((_, index) => index !== selectedIndex.value);
  const index = Math.max(0, Math.min(selectedIndex.value, next.length - 1));
  const time = clips.value.slice(0, index).reduce((total, clip) => total + clip.length, 0);
  commit(next, index, time);
}

function startPlayback() {
  if (props.disabled || !valid.value) return pause();
  if (playhead.value >= totalDuration.value) playhead.value = 0;
  seekPlayer();
}

function updatePlayback() {
  const element = preview.value;
  const clip = clips.value[playbackClipIndex];
  if (!element || !clip || seeking) return;
  const sourceTime = element.currentTime;
  if (sourceTime < clip.start - 0.001 || sourceTime >= clip.end) {
    if (element.paused) return;
    // ACT: 复用播放器帧更新跳过已删除片段；试听切点受帧率限制，导出由 FFmpeg 精确裁剪。
    const next = clips.value[++playbackClipIndex];
    if (!next) return pause();
    selectedIndex.value = playbackClipIndex;
    playhead.value = next.offset;
    seeking = true;
    element.currentTime = next.start;
    return;
  }
  playhead.value = clip.offset + Math.min(clip.length, Math.max(0, sourceTime - clip.start));
  if (!element.paused && sourceTime >= clip.end - 0.05) {
    const next = clips.value[++playbackClipIndex];
    if (!next) return pause();
    selectedIndex.value = playbackClipIndex;
    playhead.value = next.offset;
    seeking = true;
    element.currentTime = next.start;
  }
}
</script>

<style scoped lang="scss">
.videoClipEditor {
  min-width: 0;

  .previewStatus {
    margin: 0 0 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .editorPreview {
    display: block;
    width: 100%;
    height: min(30vh, 300px);
    background: #0c0e13;
    border-radius: 12px;
    object-fit: contain;

    &.unavailable { opacity: 0.55; }
  }

  .clipTimeline {
    margin-top: 16px;
    padding: 14px 16px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 12px;
    background: var(--el-fill-color-light);

    &.unavailable { opacity: 0.55; }

    .timelineHeader {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
      color: var(--el-text-color-regular);
      font-size: 12px;

      .sourceDuration { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
    }

    .timelineBody {
      margin: 0 6px;

      .editorTrack {
        position: relative;

        .timeRuler {
          position: relative;
          height: 24px;
          cursor: crosshair;

          span {
            position: absolute;
            top: 2px;
            transform: translateX(-50%);
            color: var(--el-text-color-secondary);
            font-size: 10px;
            font-variant-numeric: tabular-nums;

            &::after {
              content: "";
              position: absolute;
              top: 15px;
              left: 50%;
              height: 5px;
              border-left: 1px solid var(--el-border-color);
            }

            &:first-child { transform: none; }
            &:last-child { transform: translateX(-100%); }
          }
        }

        .segmentTrack {
          position: relative;
          height: 84px;

          .segmentItem {
            position: absolute;
            inset-block: 0;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow: hidden;
            padding: 8px 10px;
            border: 1px solid var(--el-color-primary-light-5);
            border-radius: 4px;
            text-align: left;
            color: var(--el-color-primary);
            background: var(--el-color-primary-light-9);
            cursor: pointer;

            .segmentName, .segmentRange, .segmentDuration {
              position: relative;
              z-index: 1;
              max-width: 100%;
              overflow: hidden;
              white-space: nowrap;
              font-size: 11px;
            }

            .segmentRange { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }

            &.selected {
              border: 2px solid var(--el-color-primary);
              background: var(--el-color-primary-light-8);
            }

            &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -3px; }
            &:disabled { cursor: default; opacity: 0.65; }
          }
        }

        .playhead {
          position: absolute;
          top: 20px;
          bottom: 0;
          width: 1px;
          background: var(--el-color-danger);
          pointer-events: none;

          &::before {
            content: "";
            position: absolute;
            top: -4px;
            left: -4px;
            width: 9px;
            height: 9px;
            background: inherit;
            clip-path: polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%);
          }
        }

        .cursorInput {
          position: absolute;
          inset: 0 -6px;
          width: calc(100% + 12px);
          height: 100%;
          margin: 0;
          opacity: 0;
          appearance: none;
          pointer-events: none;
          touch-action: none;

          // ACT: 仅游标附近的滑块接收拖动，其余区域用于选择片段。
          &::-webkit-slider-thumb {
            appearance: none;
            width: 12px;
            height: 108px;
            pointer-events: auto;
            cursor: ew-resize;
          }

          &::-moz-range-thumb {
            width: 12px;
            height: 108px;
            border: 0;
            pointer-events: auto;
            cursor: ew-resize;
          }

          &:disabled::-webkit-slider-thumb, &:disabled::-moz-range-thumb { pointer-events: none; }
        }

        &:has(.cursorInput:focus-visible) {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 3px;
        }
      }

      > .timeRuler {
        position: relative;
        height: 18px;
        margin-top: 4px;

        span {
          position: absolute;
          transform: translateX(-50%);
          color: var(--el-text-color-secondary);
          font-size: 10px;
          font-variant-numeric: tabular-nums;

          &:first-child { transform: none; }
          &:last-child { transform: translateX(-100%); }
        }
      }
    }
  }

  .editActions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;

    .el-button { margin: 0; }
  }
}
</style>
