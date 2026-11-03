#!/usr/bin/env bash

# ==============================================================================
# TGuserBOT 框架 - Linux 一键依赖安装、构建与全功能后台守护管理脚本
# ==============================================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 工作目录定位
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/data/run/gui.pid"
PORT_FILE="$SCRIPT_DIR/data/run/gui.port"
LOG_FILE="$SCRIPT_DIR/data/logs/gui.log"

mkdir -p "$SCRIPT_DIR/data/run" "$SCRIPT_DIR/data/logs"

# 1. 检测系统包管理器
detect_pm() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif command -v yum >/dev/null 2>&1; then
        echo "yum"
    elif command -v dnf >/dev/null 2>&1; then
        echo "dnf"
    elif command -v apk >/dev/null 2>&1; then
        echo "apk"
    elif command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    else
        echo "unknown"
    fi
}

# 2. 检查并安装编译工具链
install_build_tools() {
    local pm
    pm=$(detect_pm)
    if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
        echo -e "${YELLOW}🔍 正在检查系统编译工具链 (C++ / Python / Make)...${NC}"
        case "$pm" in
            apt)
                echo -e "${BLUE}📦 正在使用 apt 安装 build-essential 与 python3...${NC}"
                sudo apt-get update -y || true
                sudo apt-get install -y build-essential python3 git curl
                ;;
            yum|dnf)
                echo -e "${BLUE}📦 正在使用 $pm 安装开发工具链与 python3...${NC}"
                sudo "$pm" install -y gcc-c++ make python3 git curl || true
                ;;
            apk)
                sudo apk add --no-cache build-base python3 git curl || true
                ;;
            pacman)
                sudo pacman -Sy --noconfirm base-devel python git curl || true
                ;;
        esac
    fi
}

# 3. 检查 Node.js 环境 (要求 >= 22.5.0 原生内置 node:sqlite)
check_node() {
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${RED}❌ 未检测到 Node.js！${NC}"
        echo -e "${BLUE}⚡ 正在自动为您安装官方最新的 Node.js LTS 22...${NC}"
        local pm
        pm=$(detect_pm)
        if [ "$pm" = "apt" ]; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
            apt-get install -y nodejs
        else
            echo -e "${RED}请手动安装 Node.js >= 22.5.0 后重试。${NC}"
            exit 1
        fi
    fi

    local node_ver
    node_ver=$(node -v | sed 's/v//')
    local major_ver
    major_ver=$(echo "$node_ver" | cut -d. -f1)

    if [ "$major_ver" -lt 22 ]; then
        echo -e "${YELLOW}⚠️ 当前 Node.js 版本 (v${node_ver}) 缺少官方标准内置模块 'node:sqlite'。${NC}"
        echo -e "${CYAN}💡 框架持久化采用 Node 官方最新内置 SQLite 引擎，免除复杂的 C++ 编译环境。${NC}"
        echo -e "${BLUE}⚡ 正在自动为您升级至 Node.js 22 LTS...${NC}"
        local pm
        pm=$(detect_pm)
        if [ "$pm" = "apt" ]; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
            apt-get install -y nodejs
        elif [ "$pm" = "yum" ] || [ "$pm" = "dnf" ]; then
            curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
            "$pm" install -y nodejs
        else
            echo -e "${RED}请手动升级系统 Node.js 至 22.5.0 以上后重试。${NC}"
            exit 1
        fi
    fi
}

# 4. 补充/安装 npm 依赖
check_dependencies() {
    if [ ! -d "node_modules" ] || [ ! -d "node_modules/telegram" ] || [ ! -d "node_modules/ws" ]; then
        echo -e "${BLUE}🚀 正在安装/更新 npm 依赖包 (含 WebSocket 引擎)...${NC}"
        install_build_tools
        npm install
    fi

    # 自动修复可执行权限
    if [ -d "node_modules/.bin" ]; then
        chmod -R +x node_modules/.bin 2>/dev/null || true
    fi
}

# 5. 检查并生成环境配置文件 .env
check_env() {
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            echo -e "${CYAN}📄 .env 配置文件已就绪。${NC}"
        else
            touch .env
        fi
    fi
}

# 6. 编译项目 (TypeScript -> dist/)
build_project() {
    if [ "$SKIP_BUILD" != "1" ]; then
        echo -e "${BLUE}🔨 正在编译构建项目并同步前端资源...${NC}"
        npm run build || true
        echo -e "${GREEN}✅ 项目构建完成！产物已就绪于 dist/ 目录。${NC}"
    fi
}

init_all() {
    check_node
    check_dependencies
    check_env
    build_project
}

# ==============================================================================
# 服务运行状态智能识别模块
# ==============================================================================

get_running_info() {
    RUNNING_PID=""
    RUNNING_PORT=""

    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            RUNNING_PID="$pid"
            if [ -f "$PORT_FILE" ]; then
                RUNNING_PORT=$(cat "$PORT_FILE" 2>/dev/null || true)
            fi
            return 0
        fi
    fi

    # 兜底检测: 检查后台是否存在 node dist/gui/server.js 进程
    local matched_pids
    matched_pids=$(pgrep -f "dist/gui/server.js" 2>/dev/null || true)
    for p in $matched_pids; do
        if [ "$p" != "$$" ]; then
            RUNNING_PID="$p"
            if [ -f "$PORT_FILE" ]; then
                RUNNING_PORT=$(cat "$PORT_FILE" 2>/dev/null || true)
            fi
            echo "$RUNNING_PID" > "$PID_FILE"
            return 0
        fi
    done

    return 1
}

# 打印运行状态面板
show_status() {
    if get_running_info; then
        echo -e "${GREEN}======================================================${NC}"
        echo -e "${GREEN}🟢 TGuserBOT 服务正在后台健康运行中${NC}"
        echo -e "   • 进程 PID   : ${CYAN}${RUNNING_PID}${NC}"
        echo -e "   • 监听端口   : ${CYAN}${RUNNING_PORT:-3000}${NC}"
        echo -e "   • 本地访问   : ${CYAN}http://127.0.0.1:${RUNNING_PORT:-3000}${NC}"
        echo -e "   • 日志文件   : ${BLUE}data/logs/gui.log${NC}"
        echo -e "${GREEN}======================================================${NC}"
        return 0
    else
        echo -e "${YELLOW}======================================================${NC}"
        echo -e "${YELLOW}⚪ 当前 TGuserBOT 服务未在后台运行${NC}"
        echo -e "${YELLOW}======================================================${NC}"
        return 1
    fi
}

# 启动后台守护服务 (Daemon)
start_daemon() {
    init_all

    if get_running_info; then
        echo -e "${YELLOW}⚠️ 服务已在后台运行中 (PID: $RUNNING_PID, 端口: ${RUNNING_PORT:-3000})！${NC}"
        echo -e "💡 如需更换端口或重启，请先执行 ${CYAN}./start.sh restart [新端口]${NC} 或 ${CYAN}./start.sh stop${NC}"
        return 0
    fi

    local target_port="$1"
    if [ -z "$target_port" ]; then
        target_port="${GUI_PORT:-3000}"
    fi

    # 检查目标端口是否被其他服务监听占用 (绝不杀死别人的进程)
    if [ -t 0 ] && command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$target_port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠️ 提示: 端口 $target_port 当前已被系统其它服务占用！${NC}"
        read -rp "请自由输入一个未占用的空闲端口 [例如 3001, 8080, 10001]: " custom_port
        if [ -n "$custom_port" ]; then
            target_port="$custom_port"
        fi
    fi

    echo -e "${BLUE}🚀 正在启动后台守护服务 (端口: $target_port)...${NC}"
    export GUI_PORT="$target_port"
    export GUI_HOST="${GUI_HOST:-127.0.0.1}"
    export NO_OPEN_BROWSER="1"

    nohup node dist/gui/server.js "$target_port" > "$LOG_FILE" 2>&1 &
    local new_pid=$!

    echo "$new_pid" > "$PID_FILE"
    echo "$target_port" > "$PORT_FILE"

    sleep 1.5

    # 检查进程是否存活
    if kill -0 "$new_pid" 2>/dev/null; then
        echo -e "${GREEN}======================================================${NC}"
        echo -e "${GREEN}🎉 TGuserBOT Web GUI 已成功在后台运行！${NC}"
        echo -e "   • 进程 PID   : ${CYAN}${new_pid}${NC}"
        echo -e "   • 监听端口   : ${CYAN}${target_port}${NC}"
        echo -e "   • 本地访问   : ${CYAN}http://127.0.0.1:${target_port}${NC}"
        echo -e "   • 运行日志   : ${BLUE}${LOG_FILE}${NC}"
        echo -e "${GREEN}======================================================${NC}"
        echo -e "💡 常用管理命令:"
        echo -e "  • 查看实时日志 : ${CYAN}./start.sh log${NC}"
        echo -e "  • 停止后台服务 : ${CYAN}./start.sh stop${NC}"
        echo -e "  • 重启后台服务 : ${CYAN}./start.sh restart [端口]${NC}"
        echo -e "  • 检查运行状态 : ${CYAN}./start.sh status${NC}"
    else
        echo -e "${RED}❌ 启动失败，请检查日志:${NC}"
        tail -n 20 "$LOG_FILE"
        exit 1
    fi
}

# 停止后台服务
stop_daemon() {
    if get_running_info; then
        echo -e "${YELLOW}🛑 正在优雅停止 TGuserBOT 后台服务 (PID: $RUNNING_PID)...${NC}"
        kill "$RUNNING_PID" 2>/dev/null || true
        for i in {1..5}; do
            if ! kill -0 "$RUNNING_PID" 2>/dev/null; then
                break
            fi
            sleep 0.5
        done
        if kill -0 "$RUNNING_PID" 2>/dev/null; then
            echo -e "${YELLOW}强制终止进程...${NC}"
            kill -9 "$RUNNING_PID" 2>/dev/null || true
        fi
        # 彻底清理任何可能遗留的 worker 实例进程
        pkill -f "dist/manager/worker.js" 2>/dev/null || true
        rm -f "$PID_FILE"
        echo -e "${GREEN}✅ 后台服务已成功停止！${NC}"
    else
        echo -e "${YELLOW}⚪ 未检测到正在运行的 TGuserBOT 后台服务。${NC}"
    fi
}

# 重启后台服务
restart_daemon() {
    local new_port="$1"
    if [ -z "$new_port" ] && [ -f "$PORT_FILE" ]; then
        new_port=$(cat "$PORT_FILE" 2>/dev/null || true)
    fi

    echo -e "${BLUE}🔄 正在平滑重启服务...${NC}"
    stop_daemon
    sleep 1
    start_daemon "$new_port"
}

# 查看实时日志
view_logs() {
    if [ ! -f "$LOG_FILE" ]; then
        touch "$LOG_FILE"
    fi
    echo -e "${CYAN}📜 正在显示实时日志 (按 Ctrl+C 可退出日志查看，后台服务不会中断):${NC}"
    echo -e "${CYAN}------------------------------------------------------${NC}"
    tail -n 40 -f "$LOG_FILE"
}

# 前台控制台模式运行
run_foreground() {
    init_all
    echo -e "${GREEN}📟 正在启动前台命令行控制台模式...${NC}"
    npm start
}

# ==============================================================================
# 命令行参数快捷入口
# ==============================================================================

# 支持: ./start.sh 10001
if [[ "$1" =~ ^[0-9]+$ ]]; then
    start_daemon "$1"
    exit 0
fi

case "$1" in
    start)
        start_daemon "$2"
        exit 0
        ;;
    stop)
        stop_daemon
        exit 0
        ;;
    restart)
        restart_daemon "$2"
        exit 0
        ;;
    status)
        show_status
        exit 0
        ;;
    log|logs)
        view_logs
        exit 0
        ;;
    cli|console)
        run_foreground
        exit 0
        ;;
    help|--help|-h)
        echo "用法: ./start.sh [start [端口]|stop|restart [端口]|status|log|cli|<端口号>]"
        echo "  ./start.sh                : 打开交互式控制面板 (自动识别运行状态)"
        echo "  ./start.sh 10001          : 指定端口后台运行"
        echo "  ./start.sh start 10001    : 指定端口启动后台服务"
        echo "  ./start.sh stop           : 停止后台服务"
        echo "  ./start.sh restart [端口] : 重启后台服务"
        echo "  ./start.sh status         : 查看当前后台运行状态"
        echo "  ./start.sh log            : 追踪实时运行日志 (tail -f)"
        echo "  ./start.sh cli            : 单实例前台交互式控制台模式"
        exit 0
        ;;
esac

# ==============================================================================
# 交互式动态管理菜单 (根据运行状态自适应呈现)
# ==============================================================================

echo -e "${CYAN}"
echo "======================================================"
echo "          🤖 TGuserBOT Framework Linux 管理中心        "
echo "======================================================"
echo -e "${NC}"

show_status
echo ""

if get_running_info; then
    # 已运行状态的专属管理菜单
    echo -e "${CYAN}请选择操作选项:${NC}"
    echo "  1) 📜 查看实时运行日志 (tail -f)"
    echo "  2) 🔄 平滑重启后台服务"
    echo "  3) 🛑 停止后台运行服务"
    echo "  4) 🚪 退出脚本"
    echo -e "${CYAN}======================================================${NC}"
    read -rp "请输入选项编号 [1-4] (默认 1 查看日志): " choice

    case "$choice" in
        2)
            echo -e "${CYAN}💡 提示: 回车保持当前端口 (${RUNNING_PORT:-3000})，或输入新端口:${NC}"
            read -rp "请输入端口: " input_port
            restart_daemon "$input_port"
            ;;
        3)
            stop_daemon
            ;;
        4)
            echo -e "${GREEN}再见！服务将继续在后台常驻运行。${NC}"
            exit 0
            ;;
        1|"")
            view_logs
            ;;
        *)
            echo -e "${RED}无效选项，退出脚本。${NC}"
            exit 0
            ;;
    esac
else
    # 未运行状态的启动菜单
    echo -e "${CYAN}请选择启动选项:${NC}"
    echo "  1) 🚀 启动 Web GUI 服务 (自动后台守护运行，支持自由端口)"
    echo "  2) 📟 启动 单实例 CLI 命令行交互模式 (前台)"
    echo "  3) 📜 查看历史运行日志"
    echo "  4) 🚪 退出"
    echo -e "${CYAN}======================================================${NC}"
    read -rp "请输入选项编号 [1-4] (默认 1): " choice

    case "$choice" in
        2)
            run_foreground
            ;;
        3)
            view_logs
            ;;
        4)
            echo -e "${GREEN}再见！${NC}"
            exit 0
            ;;
        1|"")
            echo -e "${CYAN}💡 提示: 默认端口为 3000，如与其他服务冲突可直接输入自由端口 (如 10001、3001、8080)${NC}"
            read -rp "请输入 Web GUI 端口 [回车默认使用 3000]: " user_port
            start_daemon "$user_port"
            ;;
        *)
            echo -e "${RED}无效选项，默认启动后台 Web GUI...${NC}"
            start_daemon ""
            ;;
    esac
fi

