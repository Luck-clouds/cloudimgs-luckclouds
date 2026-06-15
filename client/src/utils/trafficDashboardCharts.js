function bytesToGB(bytes = 0) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function bytesToMB(bytes = 0) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function buildSharedTooltipStyle(formatter) {
  return {
    trigger: "item",
    backgroundColor: "rgba(255, 255, 255, 0.96)",
    borderColor: "#d9d9d9",
    borderWidth: 1,
    textStyle: {
      color: "#1f1f1f",
      fontSize: 12,
    },
    formatter,
  };
}

export function buildTrafficTrendOption(trafficData = []) {
  return {
    title: { text: "流量与上传趋势", left: "center" },
    tooltip: { trigger: "axis" },
    legend: {
      data: ["访问流量 (MB)", "上传流量 (MB)", "访问次数", "上传次数"],
      bottom: 0,
    },
    grid: { left: "3%", right: "4%", bottom: "10%", containLabel: true },
    xAxis: { type: "category", data: trafficData.map((d) => d.date) },
    yAxis: [
      { type: "value", name: "流量 (MB)", position: "left" },
      { type: "value", name: "次数", position: "right" },
    ],
    series: [
      {
        name: "访问流量 (MB)",
        type: "line",
        smooth: true,
        data: trafficData.map((d) => (d.views_size / 1024 / 1024).toFixed(2)),
        areaStyle: { opacity: 0.1 },
        itemStyle: { color: "#52c41a" },
      },
      {
        name: "上传流量 (MB)",
        type: "line",
        smooth: true,
        data: trafficData.map((d) => (d.uploads_size / 1024 / 1024).toFixed(2)),
        areaStyle: { opacity: 0.1 },
        itemStyle: { color: "#1890ff" },
      },
      {
        name: "访问次数",
        type: "bar",
        yAxisIndex: 1,
        data: trafficData.map((d) => d.views_count),
        itemStyle: { color: "#95de64", opacity: 0.5 },
      },
      {
        name: "上传次数",
        type: "bar",
        yAxisIndex: 1,
        data: trafficData.map((d) => d.uploads_count),
        itemStyle: { color: "#69c0ff", opacity: 0.5 },
      },
    ],
  };
}

export function buildStorageUsageOption(overview) {
  const storage = overview?.storage || {};
  const totalGB = bytesToGB(storage.totalBytes);
  const usedGB = bytesToGB(storage.usedBytes);
  const usagePercent = Number(storage.usagePercent || 0);

  return {
    title: {
      text: "存储使用情况",
      subtext: `已用 ${usagePercent}%`,
      left: "center",
      top: "-1%",
    },
    tooltip: buildSharedTooltipStyle(() =>
      [
        "存储使用情况",

        `本机储存大小：${totalGB} GB`,

        `已用储存大小：${usedGB} GB`,

        `使用百分比：${usagePercent}%`,
      ].join("<br/>"),
    ),
    legend: {
      orient: "vertical",
      left: "left",
    },
    series: [
      {
        name: "存储概览",
        type: "pie",
        radius: ["40%", "70%"],
        avoidLabelOverlap: false,
        label: {
          show: false,
          position: "center",
        },
        emphasis: {
          label: {
            show: false,
            fontSize: 40,
            fontWeight: "bold",
          },
        },
        labelLine: {
          show: false,
        },
        data: [
          { value: totalGB, name: "本机储存大小" },
          { value: usedGB, name: "已用储存大小" },
        ],
      },
    ],
  };
}

export function buildMediaSummaryOption(overview) {
  const media = overview?.media || {};
  const imageCount = media.imageCount || 0;
  const otherMB = bytesToMB(media.otherBytes);
  const imageMB = bytesToMB(media.imageBytes);

  return {
    title: {
      text: "媒体概览",
      subtext: `图片 ${imageCount} 张`,
      left: "center",
       top: "-1%",
    },
    tooltip: buildSharedTooltipStyle(() =>
      [
        "媒体概览",
        `总图片数量:${imageCount} 张`,
        `非图片大小:${otherMB} MB`,
        `总图片大小:${imageMB} MB`,
      ].join("<br/>"),
    ),
    legend: {
      orient: "vertical",
      left: "left",
    },
    series: [
      {
        name: "媒体统计",
        type: "pie",
        radius: "50%",
        data: [
          { value: imageCount, name: "总图片数量" },
          { value: otherMB, name: "非图片大小" },
          { value: imageMB, name: "总图片大小" },
        ],
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };
}
