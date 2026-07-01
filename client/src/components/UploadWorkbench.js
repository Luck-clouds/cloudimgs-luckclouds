import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Grid,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
  message,
  theme,
} from "antd";
import {
  CloudUploadOutlined,
  DeleteOutlined,
  InboxOutlined,
  ReloadOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import DirectorySelector from "./DirectorySelector";

const { Dragger } = Upload;
const { Title, Text } = Typography;

const DEFAULT_UPLOAD_CONFIG = {
  allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".mp4", ".webm"],
  maxFileSize: 10 * 1024 * 1024,
};

class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push(() => task().then(resolve).catch(reject));
      this.next();
    });
  }

  next() {
    if (this.active >= this.limit || this.queue.length === 0) return;
    const task = this.queue.shift();
    this.active += 1;
    task().finally(() => {
      this.active -= 1;
      this.next();
    });
  }
}

function sanitizeDir(input) {
  let dir = (input || "").trim().replace(/\\+/g, "/").replace(/\/+/g, "/");
  dir = dir.replace(/\/+$/, "");
  dir = dir.replace(/^\/+/, "");
  return dir;
}

function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function getMaxFileSizeMB(maxFileSize) {
  if (!maxFileSize) return 0;
  return Math.round((maxFileSize / 1024 / 1024) * 100) / 100;
}

function getAllowedFormats(extensions) {
  return (extensions || [])
    .map((ext) => String(ext || "").replace(/^\./, "").toUpperCase())
    .filter(Boolean)
    .join(", ");
}

function normalizeTagName(name) {
  return String(name || "").trim();
}

function uniqueTags(tags) {
  const seen = new Set();
  const result = [];
  for (const raw of tags || []) {
    const tag = normalizeTagName(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function getStatusText(item) {
  if (item.status === "waiting") return "等待提交";
  if (item.status === "uploading") return `上传中 ${item.progress || 0}%`;
  if (item.status === "uploaded") return "上传成功";
  if (item.status === "tagging") return "标签绑定中";
  if (item.status === "done") return "完成";
  if (item.status === "tagError") return "标签失败";
  if (item.status === "error") return "上传失败";
  return "等待提交";
}

function getProgressStatus(status) {
  if (status === "error" || status === "tagError") return "exception";
  if (status === "done" || status === "uploaded") return "success";
  return "active";
}

function isVideoFile(file) {
  return file?.type?.startsWith("video/") || /\.(mp4|webm|ogg)$/i.test(file?.name || "");
}

function isImageFile(file) {
  return file?.type?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(file?.name || "");
}

const UploadWorkbench = ({ api, onUploadSuccess }) => {
  const {
    token: { colorBgContainer, colorBorder, colorText, colorTextSecondary, colorPrimary, boxShadowSecondary },
  } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const isDarkMode = colorBgContainer === "#141414" || colorBgContainer === "#000000" || colorBgContainer === "#1f1f1f";

  const [dir, setDir] = useState("");
  const [config, setConfig] = useState(DEFAULT_UPLOAD_CONFIG);
  const [uploadEnabled, setUploadEnabled] = useState(true);
  const [queue, setQueue] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  const [tagModal, setTagModal] = useState({ open: false, uid: null, value: [] });
  const [submitting, setSubmitting] = useState(false);
  const limiterRef = useRef(new ConcurrencyLimiter(4));
  const queueRef = useRef([]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const uploading = queue.some((item) => item.status === "uploading" || item.status === "tagging");
  const finishedCount = queue.filter((item) => ["done", "uploaded", "tagError"].includes(item.status)).length;
  const failedCount = queue.filter((item) => item.status === "error" || item.status === "tagError").length;

  useEffect(() => {
    let mounted = true;
    api.get("/config")
      .then((response) => {
        if (!mounted || !response.data?.success) return;
        const data = response.data.data || {};
        setConfig({ ...DEFAULT_UPLOAD_CONFIG, ...(data.upload || {}) });
        setUploadEnabled(data.imageSource?.uploadEnabled !== false);
      })
      .catch((error) => {
        console.warn("获取上传配置失败:", error);
      });

    api.get("/tags")
      .then((response) => {
        if (!mounted || !response.data?.success) return;
        setAvailableTags(response.data.data || []);
      })
      .catch((error) => {
        console.warn("获取标签失败:", error);
      });

    return () => {
      mounted = false;
    };
  }, [api]);

  useEffect(() => {
    return () => {
      queueRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, []);

  const allowedAccept = useMemo(() => {
    return (config.allowedExtensions || [])
      .map((ext) => ext.startsWith(".") ? ext : `.${ext}`)
      .join(",");
  }, [config.allowedExtensions]);

  const updateQueueItem = useCallback((uid, updater) => {
    setQueue((prev) => prev.map((item) => {
      if (item.uid !== uid) return item;
      return typeof updater === "function" ? { ...item, ...updater(item) } : { ...item, ...updater };
    }));
  }, []);

  const validateFile = useCallback((file) => {
    const ext = `.${(file.name.split(".").pop() || "").toLowerCase()}`;
    const allowedExts = (config.allowedExtensions || []).map((item) => item.toLowerCase());
    if (!allowedExts.includes(ext)) {
      message.error(`${file.name} 格式不支持`);
      return false;
    }
    if (file.size > config.maxFileSize) {
      message.error(`${file.name} 超过 ${getMaxFileSizeMB(config.maxFileSize)}MB`);
      return false;
    }
    return true;
  }, [config]);

  const addFiles = useCallback((files) => {
    if (!uploadEnabled) {
      message.warning("当前配置已关闭上传入口");
      return;
    }

    const nextItems = Array.from(files || [])
      .filter(validateFile)
      .map((file) => ({
        uid: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        name: file.name,
        size: file.size,
        type: file.type || "未知类型",
        previewUrl: URL.createObjectURL(file),
        tags: [],
        appliedTags: [],
        progress: 0,
        status: "waiting",
        error: "",
        response: null,
      }));

    if (nextItems.length === 0) return;
    setQueue((prev) => [...prev, ...nextItems]);
  }, [uploadEnabled, validateFile]);

  const removeItem = useCallback((uid) => {
    setQueue((prev) => {
      const target = prev.find((item) => item.uid === uid);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.uid !== uid);
    });
  }, []);

  const clearAll = useCallback(() => {
    if (uploading) return;
    queue.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setQueue([]);
  }, [queue, uploading]);

  const openTagModal = (item) => {
    setTagModal({ open: true, uid: item.uid, value: item.tags });
  };

  const closeTagModal = () => {
    setTagModal({ open: false, uid: null, value: [] });
  };

  const applyTags = () => {
    const tags = uniqueTags(tagModal.value);
    const allTags = [];
    const localTags = [];

    tags.forEach((tag) => {
      if (/\*all$/i.test(tag)) {
        const cleanTag = normalizeTagName(tag.replace(/\*all$/i, ""));
        if (cleanTag) allTags.push(cleanTag);
      } else {
        localTags.push(tag);
      }
    });

    setQueue((prev) => prev.map((item) => {
      const baseTags = item.uid === tagModal.uid ? localTags : item.tags;
      return {
        ...item,
        tags: uniqueTags([...baseTags, ...allTags]),
      };
    }));
    closeTagModal();
  };

  const bindTags = useCallback(async (item, image) => {
    const imageId = image?.id;
    const tags = uniqueTags(item.tags);
    if (!imageId || tags.length === 0) return;

    updateQueueItem(item.uid, { status: "tagging", error: "" });
    try {
      const response = await api.post(`/images/${imageId}/tags`, { tagNames: tags });
      updateQueueItem(item.uid, {
        status: "done",
        appliedTags: response.data?.data || tags,
        progress: 100,
      });
    } catch (error) {
      updateQueueItem(item.uid, {
        status: "tagError",
        progress: 100,
        error: error?.response?.data?.error || error.message || "标签绑定失败",
      });
    }
  }, [api, updateQueueItem]);

  const uploadOne = useCallback(async (item) => {
    const safeDir = sanitizeDir(dir);
    if (safeDir.includes("..")) {
      updateQueueItem(item.uid, { status: "error", error: "目录不能包含 ..", progress: 0 });
      return;
    }

    updateQueueItem(item.uid, { status: "uploading", progress: 0, error: "" });
    const formData = new FormData();
    formData.append("images", item.file, item.file.name);
    if (safeDir) formData.append("dir", safeDir);

    try {
      const response = await api.post("/uploads/batch", formData, {
        timeout: 0,
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (event) => {
          if (!event.total) return;
          updateQueueItem(item.uid, { progress: Math.min(99, Math.round((event.loaded * 100) / event.total)) });
        },
      });

      const result = response.data?.data?.results?.[0] || response.data?.data?.[0];
      if (!response.data?.success || !result?.success) {
        throw new Error(result?.error || response.data?.error || "上传失败");
      }

      const image = result.data;
      updateQueueItem(item.uid, {
        status: item.tags.length > 0 ? "uploaded" : "done",
        progress: 100,
        response: image,
        error: "",
      });

      if (item.tags.length > 0) {
        await bindTags(item, image);
      }
    } catch (error) {
      updateQueueItem(item.uid, {
        status: "error",
        progress: 0,
        error: error?.response?.data?.error || error.message || "上传失败",
      });
    }
  }, [api, bindTags, dir, updateQueueItem]);

  const submitItems = async (items) => {
    if (items.length === 0) return;
    setSubmitting(true);
    await Promise.all(items.map((item) => limiterRef.current.add(() => uploadOne(item))));
    setSubmitting(false);
    message.success("上传任务已完成");
    if (onUploadSuccess) onUploadSuccess();
  };

  const submitAll = () => {
    if (!uploadEnabled) {
      message.warning("当前配置已关闭上传入口");
      return;
    }
    const waitingItems = queue.filter((item) => item.status === "waiting" || item.status === "error");
    submitItems(waitingItems);
  };

  const retryFailed = () => {
    const failedItems = queue.filter((item) => item.status === "error");
    submitItems(failedItems);
  };

  const retryTags = async (item) => {
    if (!item.response) return;
    await bindTags(item, item.response);
  };

  const uploadProps = {
    multiple: true,
    accept: allowedAccept,
    showUploadList: false,
    beforeUpload: (file, fileList) => {
      if (fileList[0] === file) addFiles(fileList);
      return Upload.LIST_IGNORE;
    },
    disabled: !uploadEnabled || submitting,
  };

  const tagOptions = availableTags.map((tag) => ({ label: tag.name, value: tag.name }));
  const currentModalItem = queue.find((item) => item.uid === tagModal.uid);

  return (
    <div style={{ minHeight: "100vh", padding: isMobile ? 16 : "36px 24px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <Space direction="vertical" size={4} style={{ marginBottom: 24 }}>
          <Title level={isMobile ? 4 : 2} style={{ margin: 0 }}>图片上传</Title>
          <Text type="secondary">先加入待上传列表，确认图片和标签后再统一提交。</Text>
        </Space>

        <Card
          style={{
            marginBottom: 16,
            borderRadius: 18,
            boxShadow: isDarkMode ? "none" : boxShadowSecondary,
            background: colorBgContainer,
          }}
          styles={{ body: { padding: isMobile ? 16 : 24 } }}
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <DirectorySelector
              value={dir}
              onChange={setDir}
              api={api}
              allowInput
              placeholder="选择或输入保存目录（可选）"
            />

            {!uploadEnabled && (
              <Text type="danger">当前外部图片源配置已关闭上传入口，请在配置中开启后再上传。</Text>
            )}

            <Dragger
              {...uploadProps}
              style={{
                background: isDarkMode ? "rgba(255,255,255,0.03)" : "rgba(22,119,255,0.03)",
                border: `1px dashed ${colorBorder}`,
                borderRadius: 16,
                padding: isMobile ? "20px 8px" : "34px 12px",
              }}
            >
              <p className="ant-upload-drag-icon" style={{ marginBottom: 12 }}>
                <InboxOutlined style={{ color: colorPrimary, fontSize: 42 }} />
              </p>
              <p className="ant-upload-text" style={{ color: colorText, fontSize: 16, marginBottom: 8 }}>
                点击或拖拽图片到此处添加
              </p>
              <p className="ant-upload-hint" style={{ color: colorTextSecondary }}>
                支持 {getAllowedFormats(config.allowedExtensions)}，单个文件最大 {getMaxFileSizeMB(config.maxFileSize)}MB。添加后不会立即上传。
              </p>
            </Dragger>
          </Space>
        </Card>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, margin: "20px 0 12px", flexWrap: "wrap" }}>
          <Space direction="vertical" size={0}>
            <Text strong style={{ fontSize: 16 }}>待上传列表</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>已完成 {finishedCount}/{queue.length}，失败 {failedCount}</Text>
          </Space>
          <Space wrap>
            <Button disabled={uploading || queue.length === 0} onClick={clearAll}>清空全部</Button>
            <Button disabled={uploading || !queue.some((item) => item.status === "error")} icon={<ReloadOutlined />} onClick={retryFailed}>重试失败</Button>
            <Button type="primary" icon={<CloudUploadOutlined />} loading={submitting} disabled={queue.length === 0 || uploading || !queue.some((item) => item.status === "waiting" || item.status === "error")} onClick={submitAll}>确认提交</Button>
          </Space>
        </div>

        {queue.length === 0 ? (
          <Card style={{ borderRadius: 18 }}>
            <Empty description="暂无待上传图片" />
          </Card>
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {queue.map((item) => (
              <Card
                key={item.uid}
                hoverable
                style={{ borderRadius: 16, overflow: "hidden" }}
                styles={{ body: { padding: isMobile ? 10 : 12 } }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "88px minmax(0, 1fr)" : "104px minmax(0, 1fr) 170px",
                    gap: isMobile ? 10 : 14,
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: isMobile ? 88 : 104,
                      height: isMobile ? 66 : 78,
                      borderRadius: 12,
                      background: isDarkMode ? "#111" : "#f5f7fa",
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    {isVideoFile(item.file) ? (
                      <video src={item.previewUrl} muted controls={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : isImageFile(item.file) ? (
                      <img alt={item.name} src={item.previewUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: colorTextSecondary, fontSize: 12 }}>媒体</div>
                    )}
                  </div>

                  <Space direction="vertical" size={6} style={{ minWidth: 0, width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <Text strong ellipsis style={{ display: "block", maxWidth: "100%" }}>{item.name}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{formatFileSize(item.size)} · {item.type || "未知类型"}</Text>
                      </div>
                      {isMobile && (
                        <Button
                          shape="circle"
                          size="small"
                          danger={item.status !== "error" && item.status !== "tagError"}
                          icon={item.status === "error" || item.status === "tagError" ? <ReloadOutlined /> : <DeleteOutlined />}
                          onClick={() => {
                            if (item.status === "error") uploadOne(item);
                            else if (item.status === "tagError") retryTags(item);
                            else removeItem(item.uid);
                          }}
                          disabled={item.status === "uploading" || item.status === "tagging"}
                        />
                      )}
                    </div>

                    <div style={{ minHeight: 26 }}>
                      {item.tags.length > 0 ? (
                        <Space size={[4, 4]} wrap>
                          {item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                        </Space>
                      ) : (
                        <Text type="secondary" style={{ fontSize: 12 }}>未设置标签</Text>
                      )}
                    </div>

                    <Progress percent={item.progress || 0} size="small" status={getProgressStatus(item.status)} />
                    <Text type={item.status === "error" || item.status === "tagError" ? "danger" : "secondary"} style={{ fontSize: 12 }}>
                      {item.error || getStatusText(item)}
                    </Text>

                    {isMobile && (
                      <Button
                        type="dashed"
                        size="small"
                        icon={<TagsOutlined />}
                        onClick={() => openTagModal(item)}
                        disabled={item.status === "uploading" || item.status === "tagging"}
                      >
                        标签
                      </Button>
                    )}
                  </Space>

                  {!isMobile && (
                    <Space direction="vertical" size={8} style={{ justifySelf: "end", width: 150 }}>
                      <Button
                        type="dashed"
                        size="small"
                        icon={<TagsOutlined />}
                        onClick={() => openTagModal(item)}
                        disabled={item.status === "uploading" || item.status === "tagging"}
                        block
                      >
                        标签
                      </Button>
                      <Button
                        size="small"
                        danger={item.status !== "error" && item.status !== "tagError"}
                        icon={item.status === "error" || item.status === "tagError" ? <ReloadOutlined /> : <DeleteOutlined />}
                        onClick={() => {
                          if (item.status === "error") uploadOne(item);
                          else if (item.status === "tagError") retryTags(item);
                          else removeItem(item.uid);
                        }}
                        disabled={item.status === "uploading" || item.status === "tagging"}
                        block
                      >
                        {item.status === "error" || item.status === "tagError" ? "重试" : "删除"}
                      </Button>
                    </Space>
                  )}
                </div>
              </Card>
            ))}
          </Space>
        )}
      </div>

      <Modal
        title={currentModalItem ? `编辑标签：${currentModalItem.name}` : "编辑标签"}
        open={tagModal.open}
        onCancel={closeTagModal}
        onOk={applyTags}
        okText="保存标签"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Text type="secondary">输入标签后回车确认；输入“标签名*all”可把该标签应用到当前待上传列表的全部文件。</Text>
          <Select
            mode="tags"
            style={{ width: "100%" }}
            value={tagModal.value}
            options={tagOptions}
            tokenSeparators={[",", "，", " "]}
            placeholder="输入标签，例如：天空；批量应用：天空*all"
            onChange={(value) => setTagModal((prev) => ({ ...prev, value }))}
          />
        </Space>
      </Modal>
    </div>
  );
};

export default UploadWorkbench;
