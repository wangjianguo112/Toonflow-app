<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="exporting ? '' : previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }"
    @fullscreen="player?.enterFullscreen()">
    <div class="composeContent nopan">
      <div v-if="exporting" class="exportLoading" role="status" aria-label="成片合成中">
        <el-progress type="circle" :percentage="exportProgress" :width="64" :strokeWidth="3" />
        <span>正在合成成片</span>
      </div>
      <videoPlayer
        v-else-if="previewUrl"
        ref="player"
        :src="previewUrl"
        @loadedmetadata="resizeVideo" />
      <div v-else class="composeBody">
        <div v-if="!clips.length" class="emptyHint">把视频片段节点连到本节点，即可按连线顺序拼接成片</div>
        <ol v-else class="clipList" aria-label="拼接顺序">
          <li v-for="(clip, index) in clips" :key="clip.key" class="clipItem">
            <span class="clipIndex">{{ index + 1 }}</span>
            <span class="clipName" :title="clip.name">{{ clip.name }}</span>
            <span class="clipActions">
              <el-button text :icon="IconArrowUp" :disabled="index === 0" aria-label="上移片段" title="上移" @click.stop="move(index, -1)" />
              <el-button text :icon="IconArrowDown" :disabled="index === clips.length - 1" aria-label="下移片段" title="下移" @click.stop="move(index, 1)" />
            </span>
          </li>
        </ol>
        <el-button
          type="primary"
          class="composeButton"
          :icon="IconMovie"
          :disabled="!clips.length"
          @click.stop="compose()">合成成片</el-button>
      </div>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { IconVideo, IconMovie, IconArrowUp, IconArrowDown } from "@tabler/icons-vue";
import { ElButton, ElMessage, ElProgress } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, z, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { useVueFlow } from "@vue-flow/core";
import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import videoPlayer from "@toonflow/node-video/videoPlayer";

defineOptions({
  inheritAttrs: false,
  icon: IconVideo,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO"], label: "视频片段输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "成片输出" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, nodeEvent, files, ffmpeg, updateNodeInternals } = useNode({
  label: "成片",
});
const { refList } = useNodeReferences("in");
const { findNode } = useVueFlow();
const player = ref<InstanceType<typeof videoPlayer>>();
const videoWidth = ref(0);
const exporting = ref(false);
const exportProgress = ref(0);

type Clip = { key: string; name: string; url: string; mimeType: string };
const clips = computed<Clip[]>(() => refList.value.flatMap(item => {
  if (item.dataType !== "VIDEO" || !item.value) return [];
  const label = findNode(item.source)?.data?.label;
  const name = (typeof label === "string" && label.trim())
    || item.value.url.split(/[\\/]/).at(-1) || "片段";
  return [{ key: referenceKey(item), name, url: item.value.url, mimeType: item.value.mimeType }];
}));

const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, "成片读取失败")
);

nodeEvent.on("save", (reason) => {
  if (exporting.value) throw new Error(reason === "reload" ? "成片正在合成，请完成后再刷新节点" : "成片合成中，请完成后再切换画布");
});
nodeEvent.on("delete", () => {
  if (exporting.value) throw new Error("成片合成中，请先取消再删除节点");
  return files.removeNodeFiles();
});

function referenceKey(item: { source: string; sourceHandle: string }) {
  return encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]));
}

function move(index: number, offset: number) {
  const list = [...refList.value];
  const target = index + offset;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target]!, list[index]!];
  refList.value = list;
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, (240 * video.videoWidth) / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}

function runCommand(command: BrowserFfmpegCommand, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal?.aborted) command.kill(); });
    command.on("progress", progress => {
      if (typeof progress.percent === "number" && Number.isFinite(progress.percent)) {
        exportProgress.value = Math.min(99, Math.max(0, Math.round(progress.percent)));
      }
    });
    command.on("error", error => reject(signal?.aborted ? signal.reason : error));
    command.on("end", () => signal?.aborted ? reject(signal.reason) : resolve());
    command.run();
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

function probeMedia(factory: BrowserFfmpegFactory, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const command = factory(path);
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<FfprobeData>((resolve, reject) => {
    command.ffprobe((error, info) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(info);
    });
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

function evenSize(value: number) {
  return Math.max(2, Math.ceil(value / 2) * 2);
}

function parseFps(rate: string | undefined) {
  if (!rate) return 0;
  const [numerator, denominator] = rate.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) return 0;
  return numerator / denominator;
}

/** 拼接为统一规格的 H.264 MP4：尺寸取各片段最大值并补齐偶数，帧率取最高，缺音轨的片段补静音。 */
async function compose(signal?: AbortSignal) {
  if (exporting.value) throw new Error("成片正在合成，请稍后再试");
  const list = clips.value;
  if (!list.length) throw new Error("请先连接至少一个视频片段节点");
  const current = new AbortController();
  const combined = signal ? AbortSignal.any([signal, current.signal]) : current.signal;
  exporting.value = true;
  exportProgress.value = 0;
  const workspace = files.getWorkspaceFiles();
  const directory = `assets/${crypto.randomUUID()}`;
  let committed = false;
  try {
    await workspace.mkdir("assets").catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error?.response?.data?.data?.code !== "EEXIST") throw error;
    });
    await workspace.mkdir(directory);
    const outPath = `${directory}/compose.mp4`;
    const factory = await ffmpeg(combined);
    combined.throwIfAborted();

    const infos = [];
    for (const clip of list) infos.push(await probeMedia(factory, clip.url, combined));
    const videos = infos.map(info => info.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic));
    if (videos.some(video => !video)) throw new Error("存在不包含视频画面的片段");
    const durations = infos.map(info => Number(info.format.duration ?? videos.find(video => video)?.duration));
    if (durations.some(duration => !Number.isFinite(duration) || duration <= 0)) throw new Error("无法读取片段时长");
    const width = evenSize(Math.max(...videos.map(video => video!.width ?? 0)));
    const height = evenSize(Math.max(...videos.map(video => video!.height ?? 0)));
    if (!width || !height) throw new Error("无法读取片段尺寸");
    const fps = Math.min(60, Math.max(12, Math.round(Math.max(0, ...infos.map(info => {
      const video = info.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
      return parseFps(video?.avg_frame_rate);
    })))) || 30);
    const hasAudio = infos.map(info => info.streams.some(stream => stream.codec_type === "audio"));
    if (!hasAudio.some(Boolean)) throw new Error("所有片段都没有音轨，无法合成有声成片");

    const command = factory();
    for (const clip of list) command.input(clip.url);
    for (let index = 0; index < list.length; index += 1) {
      if (!hasAudio[index]) command.input("anullsrc=r=44100:cl=stereo").inputOptions("-f", "lavfi");
    }

    const chains: string[] = [];
    const labels: string[] = [];
    let nullIndex = list.length;
    for (let index = 0; index < list.length; index += 1) {
      chains.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`);
      if (hasAudio[index]) {
        chains.push(`[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
      } else {
        chains.push(`[${nullIndex}:a]atrim=duration=${durations[index]!.toFixed(3)},asetpts=N/SR/TB[a${index}]`);
        nullIndex += 1;
      }
      labels.push(`[v${index}][a${index}]`);
    }
    command.complexFilter([...chains, `${labels.join("")}concat=n=${list.length}:v=1:a=1[vout][aout]`]);
    command.output(outPath).videoCodec("libx264").audioCodec("aac").audioBitrate(192).format("mp4")
      .outputOptions("-map", "[vout]", "-map", "[aout]", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-ar", "44100", "-ac", "2");
    await runCommand(command, combined);
    combined.throwIfAborted();
    outputs.value.video = { dataType: "VIDEO", value: { url: outPath, mimeType: "video/mp4" } };
    committed = true;
    ElMessage.success("成片已生成");
  } catch (error) {
    if (!combined.aborted) showError(error, "成片合成失败");
    throw error;
  } finally {
    if (!committed) await workspace.remove(directory, true).catch(() => {});
    exporting.value = false;
  }
}

nodeTools.register({
  name: "composeVideo",
  description: "把连接到本节点的视频片段按当前顺序拼接为一部成片并输出到节点",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    await compose(signal);
    return outputs.value.video;
  },
});

nodeTools.register({
  name: "setComposeOrder",
  description: "调整成片拼接顺序，keys 按 `${来源节点ID}:${来源端口ID}` 的顺序列出全部片段",
  parameters: z.strictObject({
    keys: z.array(z.string().min(1).max(512)).min(1).max(200),
  }),
  async execute({ keys }, { signal }) {
    signal?.throwIfAborted();
    const known = new Map(clips.value.map(clip => [clip.key, clip]));
    const ordered = keys.flatMap(key => {
      const clip = known.get(key);
      return clip ? [clip] : [];
    });
    if (ordered.length !== clips.value.length) throw new Error("keys 必须覆盖当前全部片段");
    refList.value = refList.value.filter(item => ordered.some(clip => clip.key === referenceKey(item)));
    return { order: ordered.map((clip, index) => ({ index: index + 1, name: clip.name })) };
  },
});
</script>

<style scoped lang="scss">
.composeContent {
  .nodeSkeleton.resized & {
    height: 100%;
    min-height: 0;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    --nodeMediaHeight: 100%;

    .exportLoading { max-height: 100%; box-sizing: border-box; overflow: auto; }
  }

  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .exportLoading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 20px;
    color: var(--el-text-color-secondary);
  }

  .composeBody {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    width: 100%;
    padding: 12px;
    box-sizing: border-box;

    .emptyHint {
      padding: 8px 4px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.6;
      text-align: center;
    }

    .clipList {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 220px;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;

      .clipItem {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 4px 6px;
        border-radius: var(--el-border-radius-base);
        background: var(--el-fill-color-light);

        .clipIndex {
          flex-shrink: 0;
          min-width: 18px;
          color: var(--el-text-color-secondary);
          font-size: 12px;
          text-align: center;
        }

        .clipName {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }

        .clipActions {
          flex-shrink: 0;
          display: inline-flex;
        }
      }
    }

    .composeButton {
      width: 100%;
    }
  }
}
</style>
