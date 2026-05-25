# 使用官方轻量级 Python 镜像
FROM python:3.9-slim

# 设置工作目录
WORKDIR /app

# 复制依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制核心代码
COPY app.py .

# 暴露 8080 端口
EXPOSE 8080

# 使用 Gunicorn 启动生产级服务器。1GB VPS 上 2 个 worker 更稳。
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8080", "app:app"]
