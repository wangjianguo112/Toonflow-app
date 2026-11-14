import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";

export type VideoSegment = { start: number; end: number };
export type VideoCrop = { x: number; y: number; width: number; height: number };

export type VideoProcessingOptions = {
  action: "extractAudio" | "separate" | "trim" | "clip" | "speed" | "adjust";
  audioPath?: string;
  videoPath?: string;
  start?: number;
  end?: number;
  segments?: VideoSegment[];
  speed?: number;
  rotate?: 0 | 90 | 180 | 270;
  flip?: "" | "h" | "v";
  crop?: VideoCrop | undefined;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

function normalizePath(path: string) {
  if (!path || /[\x00-\x1f]/.test(path) || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error("视频处理必须使用工作区相对路径");
  }
  return path.split(/[\\/]+/).filter(part => part && part !== ".").join("/").toLowerCase();
}

function probeMedia(ffmpeg: BrowserFfmpegFactory, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const command = ffmpeg(path);
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<FfprobeData>((resolve, reject) => {
    command.ffprobe((error, data) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(data);
    });
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

function runCommand(command: BrowserFfmpegCommand, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal?.aborted) command.kill(); });
    command.on("error", error => reject(signal?.aborted ? signal.reason : error));
    command.on("end", () => signal?.aborted ? reject(signal.reason) : resolve());
    command.run();
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

function validateSegments(segments: VideoSegment[], duration: number) {
  if (!Array.isArray(segments) || segments.length === 0
    || segments.some(segment => !segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end <= segment.start || segment.end > duration)) {
    throw new Error("每个片段须满足 0 ≤ 开始时间 < 结束时间 ≤ 视频时长");
  }
}

function validateCrop(crop: VideoCrop | undefined, width: number, height: number) {
  if (!crop) return;
  const { x, y, width: w, height: h } = crop;
  for (const value of [x, y, w, h]) {
    if (!Number.isFinite(value)) throw new Error("裁切参数必须为数字");
  }
  if (w < 2 || h < 2) throw new Error("裁切宽高至少为 2 像素");
  if (x < 0 || y < 0 || x + w > width || y + h > height) {
    throw new Error(`裁切区域超出画面（画面 ${width}×${height}）`);
  }
}

/** 目录创建、唯一文件名和失败清理由调用方负责，原视频始终保留。 */
export async function processVideo(ffmpeg: BrowserFfmpegFactory, source: string, options: VideoProcessingOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const needsAudio = options.action !== "trim";
  const needsVideo = options.action !== "extractAudio";
  const videoPath = options.videoPath;
  const audioPath = options.audioPath;
  const outputs = [needsAudio ? audioPath : undefined, needsVideo ? videoPath : undefined]
    .filter((path): path is string => !!path).map(normalizePath);
  if (outputs.includes(normalizePath(source)) || new Set(outputs).size !== outputs.length) throw new Error("输出文件不能覆盖原视频或彼此覆盖");
  if (!["extractAudio", "separate", "trim", "clip", "speed", "adjust"].includes(options.action)) throw new Error("未知的视频处理操作");

  const media = await probeMedia(ffmpeg, source, signal);
  const video = media.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (needsVideo && !video) throw new Error("文件不包含视频画面");
  const duration = Number(media.format.duration ?? video?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效的视频时长");
  const hasAudio = media.streams.some(stream => stream.codec_type === "audio");
  if (needsAudio && !hasAudio) throw new Error("该视频没有音轨");
  if (options.action === "trim" && (!Number.isFinite(options.start) || !Number.isFinite(options.end)
    || options.start! < 0 || options.end! <= options.start! || options.end! > duration)) {
    throw new Error("截取范围须满足 0 ≤ 开始时间 < 结束时间 ≤ 视频时长");
  }
  if (options.action === "clip") validateSegments(options.segments!, duration);
  const speed = options.speed;
  if (options.action === "speed" && (speed === undefined || !Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new Error("视频速度须在 0.25 至 4 倍之间");
  }
  if (options.action === "adjust") {
    validateCrop(options.crop, video!.width ?? 0, video!.height ?? 0);
    if (options.volume !== undefined && (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 3)) {
      throw new Error("音量倍数须在 0 至 3 之间");
    }
    for (const fade of [options.fadeIn, options.fadeOut]) {
      if (fade !== undefined && (!Number.isFinite(fade) || fade < 0 || fade > 5 || fade > duration / 2)) {
        throw new Error("淡入淡出时长须在 0 至 5 秒之间且不超过视频时长的一半");
      }
    }
  }

  const command = ffmpeg(source);

  if (options.action === "extractAudio" || options.action === "separate" || options.action === "trim") {
    if (needsAudio) {
      command.output(normalizePath(audioPath!)).noVideo().audioCodec("aac").audioBitrate(192).format("ipod")
        .outputOptions("-map", "0:a:0", "-movflags", "+faststart");
    }
    if (needsVideo) {
      command.output(normalizePath(videoPath!)).videoCodec("libx264").format("mp4")
        .videoFilters("pad=ceil(iw/2)*2:ceil(ih/2)*2")
        .outputOptions("-map", `0:${video!.index}`, "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
      if (options.action === "separate") command.noAudio();
      else if (options.action === "trim") {
        command.seekInput(options.start!).duration(options.end! - options.start!)
          .audioCodec("aac").audioBitrate(192).outputOptions("-map", "0:a:0?");
      } else command.duration(duration).audioCodec("aac").audioBitrate(192).outputOptions("-map", "0:a:0?");
    }
    await runCommand(command, signal);
    return finishProbe(ffmpeg, (needsVideo ? videoPath : audioPath)!, signal, 0);
  }

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];

  if (options.action === "clip") {
    const segments = options.segments!;
    const filters: string[] = [];
    const videoLabels: string[] = [];
    const audioLabels: string[] = [];
    segments.forEach((segment, index) => {
      filters.push(`[0:v:0]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`);
      videoLabels.push(`[v${index}]`);
      if (hasAudio) {
        filters.push(`[0:a:0]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`);
        audioLabels.push(`[a${index}]`);
      }
    });
    // ACT: 视频/音频各自单独 concat，避免一个滤镜元素带双输出标签被 fluent 拆坏。
    filters.push(`${videoLabels.join("")}concat=n=${segments.length}:v=1:a=0[cv]`);
    filters.push("[cv]pad=ceil(iw/2)*2:ceil(ih/2)*2[cvo]");
    if (hasAudio) filters.push(`${audioLabels.join("")}concat=n=${segments.length}:v=0:a=1[ca]`);
    command.output(normalizePath(videoPath!)).complexFilter(filters)
      .outputOptions("-map", "[cvo]", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart")
      .videoCodec("libx264");
    if (hasAudio) command.outputOptions("-map", "[ca]").audioCodec("aac").audioBitrate(192);
  } else {
    if (options.action === "speed") {
      const speedValue = speed!;
      videoFilters.push(`setpts=PTS/${speedValue}`);
      let tempo = speedValue;
      // ACT: 每级保持在 0.5–2 倍，避免高倍 atempo 跳过采样，与音频节点同一套链。
      while (tempo < 0.5) { audioFilters.push("atempo=0.5"); tempo /= 0.5; }
      while (tempo > 2) { audioFilters.push("atempo=2"); tempo /= 2; }
      audioFilters.push(`atempo=${tempo.toFixed(4)}`);
    } else {
      const rotate = options.rotate ?? 0;
      if (options.speed !== undefined && options.speed !== 1) {
        videoFilters.push(`setpts=PTS/${options.speed}`);
        let tempo = options.speed;
        // ACT: 每级保持在 0.5–2 倍，避免高倍 atempo 跳过采样，与音频节点同一套链。
        while (tempo < 0.5) { audioFilters.push("atempo=0.5"); tempo /= 0.5; }
        while (tempo > 2) { audioFilters.push("atempo=2"); tempo /= 2; }
        audioFilters.push(`atempo=${tempo.toFixed(4)}`);
      }
      if (rotate === 90) videoFilters.push("transpose=clock");
      else if (rotate === 270) videoFilters.push("transpose=cclock");
      else if (rotate === 180) videoFilters.push("hflip", "vflip");
      if (options.flip === "h") videoFilters.push("hflip");
      else if (options.flip === "v") videoFilters.push("vflip");
      if (options.crop) {
        const w = Math.ceil(options.crop.width / 2) * 2;
        const h = Math.ceil(options.crop.height / 2) * 2;
        videoFilters.push(`crop=${w}:${h}:${Math.round(options.crop.x)}:${Math.round(options.crop.y)}`);
      }
      if (options.volume !== undefined && options.volume !== 1) audioFilters.push(`volume=${options.volume}`);
      if (hasAudio) {
        if (options.fadeIn) audioFilters.push(`afade=t=in:st=0:d=${options.fadeIn}`);
        if (options.fadeOut) audioFilters.push(`afade=t=out:st=${Math.max(0, duration - options.fadeOut!).toFixed(3)}:d=${options.fadeOut}`);
      }
      if (options.fadeIn) videoFilters.push(`fade=t=in:st=0:d=${options.fadeIn}`);
      if (options.fadeOut) videoFilters.push(`fade=t=out:st=${Math.max(0, duration - options.fadeOut!).toFixed(3)}:d=${options.fadeOut}`);
    }
    videoFilters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
    command.output(normalizePath(videoPath!)).videoCodec("libx264").format("mp4")
      .outputOptions("-map", "0:v:0", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart")
      .videoFilters(videoFilters);
    if (hasAudio) {
      command.outputOptions("-map", "0:a:0").audioCodec("aac").audioBitrate(192);
      if (audioFilters.length) command.audioFilters(audioFilters);
    }
  }

  await runCommand(command, signal);
  const rotate = options.action === "adjust" ? options.rotate ?? 0 : 0;
  return finishProbe(ffmpeg, videoPath!, signal, rotate);
}

async function finishProbe(ffmpeg: BrowserFfmpegFactory, path: string, signal: AbortSignal | undefined, rotate: number) {
  const result = await probeMedia(ffmpeg, path, signal);
  const resultVideo = result.streams.find(stream => stream.codec_type === "video");
  const resultDuration = Number(result.format.duration);
  if (!Number.isFinite(resultDuration) || resultDuration <= 0 || !resultVideo) throw new Error("生成的视频文件无效");
  const width = resultVideo.width ?? 0;
  const height = resultVideo.height ?? 0;
  // ACT: 90/270 度旋转后宽高互换，供新建节点按比例排布。
  return rotate === 90 || rotate === 270
    ? { duration: resultDuration, width: height, height: width }
    : { duration: resultDuration, width, height };
}
