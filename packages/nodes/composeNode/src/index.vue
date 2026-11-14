<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="exporting ? '' : previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }"
    @fullscreen="player?.enterFullscreen()">
    <div class="videoContent nopan">
      <div v-if="exporting" class="exportLoading" role="status" aria-label="成片合成中">
        <el-progress type="circle" :percentage="exportProgress" :width="64" :strokeWidth="3" />
        <span>正在合成成片</span>
      </div>
      <videoPlayer
        v-else-if="previewUrl"
        ref="player"
        :src="previewUrl"
        label="成片"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无成片">
        <icon-movie :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <div v-if="!refList.length" class="referenceHint">把视频片段节点连到本节点，即可按连线顺序拼接成片</div>
        <div v-if="clips.length >= 2" class="referenceHint composeOption">
          <span>片段转场</span>
          <el-radio-group v-model="transitionMode" size="small" aria-label="片段转场">
            <el-radio-button value="none">无</el-radio-button>
            <el-radio-button value="fade">叠化</el-radio-button>
            <el-radio-button value="slideleft">滑动</el-radio-button>
            <el-radio-button value="wipeleft">擦除</el-radio-button>
          </el-radio-group>
        </div>
        <template v-if="audioRefList.length">
          <referenceItem
            v-model="audioRefList"
            @preview="setAudioPreview"
            @remove="removeAudioReference" />
          <div class="referenceHint composeOption">
            <span>配音音轨 · 替换或与片段原声混合</span>
            <el-radio-group v-model="audioMode" size="small" aria-label="配音方式">
              <el-radio-button value="replace">替换原声</el-radio-button>
              <el-radio-button value="mix">与原声混合</el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <template v-if="subtitleRefList.length">
          <referenceItem
            v-model="subtitleRefList"
            @remove="removeSubtitleReference" />
          <div class="referenceHint">字幕 · SRT 文本或逐行台词（逐行台词按成片时长均匀分配），合成时烧录进画面</div>
        </template>
        <div v-else-if="subtitleText" class="referenceHint">字幕 · 节点内文本（{{ subtitleText.length }} 字），合成时烧录进画面</div>
        <div class="promptFooter">
          <el-button
            class="sendButton"
            :icon="IconMovie"
            :disabled="exporting || !clips.length"
            title="合成成片"
            aria-label="合成成片"
            @click="compose().catch(() => {})" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { IconVideo, IconMovie } from "@tabler/icons-vue";
import { ElButton, ElCard, ElProgress, ElRadioGroup, ElRadioButton } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, z, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import referenceItem from "@toonflow/node-shared/referenceItem";
import videoPlayer from "@toonflow/node-video/videoPlayer";

defineOptions({
  inheritAttrs: false,
  icon: IconVideo,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO"], label: "视频片段输入" },
    { id: "audio", type: "target", dataType: ["AUDIO"], label: "配音音轨（可选）" },
    { id: "subtitle", type: "target", dataType: ["STRING"], label: "字幕文本（可选，SRT 或逐行台词）" },
    { id: "video", type: "source", dataType: "VIDEO", label: "成片输出" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, nodeEvent, files, ffmpeg, updateNodeInternals } = useNode({
  label: "成片",
});
const { refList, setReferencePreview, removeReference } = useNodeReferences("in");
const { refList: audioRefList, setReferencePreview: setAudioPreview, removeReference: removeAudioReference } = useNodeReferences("audio");
const { refList: subtitleRefList, removeReference: removeSubtitleReference } = useNodeReferences("subtitle");
const { findNode } = useVueFlow();
const player = ref<InstanceType<typeof videoPlayer>>();
const videoWidth = ref(0);
const exporting = ref(false);
const exportProgress = ref(0);

const data = computed(() => node.data as { audioMode?: "replace" | "mix"; subtitleText?: string; transition?: "none" | "fade" | "slideleft" | "wipeleft" });
const audioMode = computed({
  get: () => data.value.audioMode ?? "replace",
  set: (mode: "replace" | "mix") => { data.value.audioMode = mode; },
});
const transitionMode = computed({
  get: () => data.value.transition ?? "none",
  set: (mode: "none" | "fade" | "slideleft" | "wipeleft") => { data.value.transition = mode; },
});

type Clip = { key: string; name: string; url: string; mimeType: string };
const clips = computed<Clip[]>(() => refList.value.flatMap(item => {
  if (item.dataType !== "VIDEO" || !item.value) return [];
  const label = findNode(item.source)?.data?.label;
  const name = (typeof label === "string" && label.trim())
    || item.value.url.split(/[\\/]/).at(-1) || "片段";
  return [{ key: referenceKey(item), name, url: item.value.url, mimeType: item.value.mimeType }];
}));

const audioClip = computed(() => {
  const item = audioRefList.value.find(entry => entry.dataType === "AUDIO" && entry.value);
  if (!item?.value || typeof item.value === "string") return undefined;
  return { url: item.value.url, mimeType: item.value.mimeType };
});

const subtitleText = computed(() => {
  const fromInputs = subtitleRefList.value
    .filter(item => item.dataType === "STRING" && typeof item.value === "string" && item.value.trim())
    .map(item => item.value as string).join("\n\n").trim();
  if (fromInputs) return fromInputs;
  return typeof data.value.subtitleText === "string" ? data.value.subtitleText.trim() : "";
});

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

/** 把 SRT 或逐行台词规范成 SRT 正文；无时间戳的台词按总时长均匀分配。 */
function buildSrt(source: string, totalDuration: number): string | undefined {
  const lineEnd = (line: string) => line.replace(/\r/g, "").trimEnd();
  if (source.includes("-->")) {
    const blocks: string[] = [];
    for (const block of source.replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n").filter(line => line.trim());
      const timeIndex = lines.findIndex(line => line.includes("-->"));
      if (timeIndex < 0 || timeIndex + 1 >= lines.length) continue;
      const match = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(lines[timeIndex]!);
      if (!match) continue;
      const text = lines.slice(timeIndex + 1).map(lineEnd).filter(Boolean).join("\n");
      if (!text) continue;
      blocks.push(`${blocks.length + 1}\n${match[1]!.replace(",", ".")} --> ${match[2]!.replace(",", ".")}\n${text}`);
    }
    return blocks.length ? blocks.join("\n\n") + "\n" : undefined;
  }
  const lines = source.replace(/\r/g, "").split("\n").map(lineEnd).filter(Boolean);
  if (!lines.length) return undefined;
  const interval = totalDuration / lines.length;
  const format = (seconds: number) => {
    const clamped = Math.max(0, Math.min(totalDuration, seconds));
    const whole = Math.floor(clamped);
    const milli = Math.round((clamped - whole) * 1000);
    const pad = (value: number, size: number) => String(value).padStart(size, "0");
    return `${pad(Math.floor(whole / 3600), 2)}:${pad(Math.floor(whole / 60) % 60, 2)}:${pad(whole % 60, 2)},${pad(milli, 3)}`;
  };
  return lines.map((text, index) => `${index + 1}\n${format(index * interval)} --> ${format((index + 1) * interval)}\n${text}`).join("\n\n") + "\n";
}

/** 拼接为统一规格的 H.264 MP4：尺寸取各片段最大值补齐偶数、帧率取最高、缺音轨补静音；可选配音轨与字幕烧录。 */
async function compose(signal?: AbortSignal) {
  if (exporting.value) throw new Error("成片正在合成，请稍后再试");
  const list = clips.value;
  if (!list.length) throw new Error("请先连接至少一个视频片段节点");
  const dubbing = audioClip.value;
  const mode = audioMode.value;
  const subtitle = subtitleText.value.trim();
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
    if (!hasAudio.some(Boolean) && !dubbing) throw new Error("所有片段都没有音轨，且未连接配音；无法合成有声成片");
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);

    // 字幕：解析为 SRT 并写入工作区；确认当前 FFmpeg 支持 subtitles 滤镜。
    let subtitlePath: string | undefined;
    if (subtitle) {
      const filters = await factory.availableFilters().catch(() => null as Record<string, unknown> | null);
      const filterNames = Array.isArray(filters) ? filters.map(item => typeof item === "string" ? item : (item as { name?: string })?.name)
        : filters ? Object.keys(filters) : [];
      if (!filterNames.includes("subtitles")) {
        throw new Error("当前 FFmpeg 不支持字幕滤镜（缺少 subtitles），请升级 FFmpeg 或去掉字幕后合成");
      }
      const srt = buildSrt(subtitle, totalDuration);
      if (!srt) throw new Error("字幕文本无法解析为 SRT（检查时间戳格式或逐行台词）");
      subtitlePath = `${directory}/sub.srt`;
      await workspace.write(subtitlePath, srt);
    }

    const command = factory();
    for (const clip of list) command.input(clip.url);
    const concatAudio = hasAudio.some(Boolean) ? 1 : 0;
    let missingAudioCount = 0;
    if (concatAudio) {
      for (let index = 0; index < list.length; index += 1) {
        if (!hasAudio[index]) command.input("anullsrc=r=44100:cl=stereo").inputOptions("-f", "lavfi");
      }
      missingAudioCount = hasAudio.filter(has => !has).length;
    }
    if (dubbing) command.input(dubbing.url);
    const dubbingIndex = dubbing ? list.length + missingAudioCount : -1;

    const chains: string[] = [];
    const labels: string[] = [];
    let nullInput = list.length;
    for (let index = 0; index < list.length; index += 1) {
      chains.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`);
      if (concatAudio) {
        if (hasAudio[index]) {
          chains.push(`[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
        } else {
          chains.push(`[${nullInput}:a]atrim=duration=${durations[index]!.toFixed(3)},asetpts=N/SR/TB[a${index}]`);
          nullInput += 1;
        }
        labels.push(`[v${index}][a${index}]`);
      } else {
        labels.push(`[v${index}]`);
      }
    }

    // ACT: 转场时长取 0.5 秒与最短片段一半的较小值；过短片段自动退回直接拼接。
    const transition = clips.length >= 2 && transitionMode.value !== "none"
      ? Math.min(0.5, Math.floor(Math.min(...durations) / 2 * 100) / 100) : 0;
    let videoLabel: string;
    let concatAudioLabel = "";
    if (transition >= 0.1) {
      const type = transitionMode.value;
      let accumulated = durations[0]!;
      let lastVideo = "[v0]";
      let lastAudio = concatAudio ? "[a0]" : "";
      for (let index = 1; index < list.length; index += 1) {
        const offset = Math.max(0, accumulated - transition).toFixed(3);
        const videoOut = `[vx${index}]`;
        chains.push(`${lastVideo}[v${index}]xfade=transition=${type}:duration=${transition.toFixed(3)}:offset=${offset}${videoOut}`);
        lastVideo = videoOut;
        if (concatAudio) {
          const audioOut = `[ax${index}]`;
          chains.push(`${lastAudio}[a${index}]acrossfade=d=${transition.toFixed(3)}${audioOut}`);
          lastAudio = audioOut;
        }
        accumulated = accumulated + durations[index]! - transition;
      }
      videoLabel = lastVideo;
      concatAudioLabel = lastAudio;
    } else {
      chains.push(`${labels.join("")}concat=n=${list.length}:v=1:a=${concatAudio}[vout]${concatAudio ? "[aout]" : ""}`);
      videoLabel = "[vout]";
      concatAudioLabel = concatAudio ? "[aout]" : "";
    }

    if (subtitlePath) {
      const fontSize = Math.max(14, Math.round(height / 27));
      const style = `FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=0,Bold=1,MarginV=${Math.round(height / 16)}`;
      chains.push(`${videoLabel}subtitles=${subtitlePath}:force_style='${style}'[vsub]`);
      videoLabel = "[vsub]";
    }

    let audioLabel = "";
    if (dubbing) {
      chains.push(`[${dubbingIndex}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[ax]`);
      if (concatAudioLabel) {
        if (mode === "mix") {
          chains.push(`${concatAudioLabel}[ax]amix=inputs=2:duration=first[aout2]`);
          audioLabel = "[aout2]";
        } else {
          audioLabel = "[ax]";
        }
      } else {
        audioLabel = "[ax]";
      }
    } else if (concatAudioLabel) {
      audioLabel = concatAudioLabel;
    }
    if (!audioLabel) throw new Error("无法确定成片音轨");

    command.complexFilter(chains);
    command.output(outPath).videoCodec("libx264").audioCodec("aac").audioBitrate(192).format("mp4")
      .outputOptions("-map", videoLabel, "-map", audioLabel, "-preset", "fast", "-crf", "18",
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
  description: "把连接到本节点的视频片段按当前顺序拼接为成片，并按配置混入配音音轨、烧录字幕，输出到节点",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    await compose(signal);
    return outputs.value.video;
  },
});

nodeTools.register({
  name: "setSubtitles",
  description: "设置成片字幕文本；支持 SRT 格式（含时间戳）或逐行台词（按成片时长均匀分配）",
  parameters: z.strictObject({
    text: z.string().min(1).max(100000),
  }),
  async execute({ text }, { signal }) {
    signal?.throwIfAborted();
    data.value.subtitleText = text;
    return { length: text.length, preview: text.slice(0, 120) };
  },
});

nodeTools.register({
  name: "setComposeAudioMode",
  description: "设置配音音轨的使用方式：replace 替换片段原声，mix 与片段原声混合",
  parameters: z.strictObject({
    mode: z.enum(["replace", "mix"]),
  }),
  async execute({ mode }, { signal }) {
    signal?.throwIfAborted();
    audioMode.value = mode;
    return { mode };
  },
});

nodeTools.register({
  name: "setComposeTransition",
  description: "设置片段间转场：none 直接拼接，fade 叠化，slideleft 滑动，wipeleft 擦除；转场时长自动取 0.5 秒与最短片段一半的较小值",
  parameters: z.strictObject({
    type: z.enum(["none", "fade", "slideleft", "wipeleft"]),
  }),
  async execute({ type }, { signal }) {
    signal?.throwIfAborted();
    transitionMode.value = type;
    return { type };
  },
});
</script>

<style scoped lang="scss">
.videoContent {
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

  .videoEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }
}

.promptCard {
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .composeOption {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .generationActions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
