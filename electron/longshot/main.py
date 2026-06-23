"""Manual-scroll long screenshot tool — PySide6 MVP."""
import sys
import os
from datetime import datetime

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QScrollArea, QStatusBar, QFileDialog, QMessageBox,
)
from PySide6.QtCore import Qt, QTimer, QRect, QSize
from PySide6.QtGui import QPixmap, QImage, QKeySequence, QShortcut

from selector import RegionSelector
from capture import CaptureEngine
from stitcher import Stitcher


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("长截图工具")
        self.resize(700, 560)

        self._region: QRect | None = None
        self._engine: CaptureEngine | None = None
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._on_tick)
        self._result_image: "np.ndarray | None" = None
        self._stitcher = Stitcher()

        # UI
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)

        # Buttons
        btn_row = QHBoxLayout()
        self._btn_select = QPushButton("选择区域")
        self._btn_start = QPushButton("开始捕获")
        self._btn_stop = QPushButton("停止并拼接")
        self._btn_export = QPushButton("导出 PNG")
        self._btn_start.setEnabled(False)
        self._btn_stop.setEnabled(False)
        self._btn_export.setEnabled(False)

        btn_row.addWidget(self._btn_select)
        btn_row.addWidget(self._btn_start)
        btn_row.addWidget(self._btn_stop)
        btn_row.addWidget(self._btn_export)
        layout.addLayout(btn_row)

        # Region label
        self._lbl_region = QLabel("未选择区域")
        self._lbl_region.setStyleSheet("color: #888; font-size: 12px;")
        layout.addWidget(self._lbl_region)

        # Progress
        self._lbl_progress = QLabel("")
        self._lbl_progress.setStyleSheet("color: #aaa; font-size: 12px;")
        layout.addWidget(self._lbl_progress)

        # Preview
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setStyleSheet("background: #1e1e2e; border: 1px solid #333; border-radius: 8px;")
        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignTop | Qt.AlignHCenter)
        self._preview.setMinimumHeight(200)
        self._preview.setStyleSheet("background: transparent;")
        self._scroll.setWidget(self._preview)
        layout.addWidget(self._scroll, 1)

        # Status bar
        self._status = QStatusBar()
        self.setStatusBar(self._status)
        self._status.showMessage("就绪 — 点击「选择区域」开始")

        # Signals
        self._btn_select.clicked.connect(self._on_select)
        self._btn_start.clicked.connect(self._on_start)
        self._btn_stop.clicked.connect(self._on_stop)
        self._btn_export.clicked.connect(self._on_export)

        # Shortcuts
        QShortcut(QKeySequence("Escape"), self, activated=self._on_stop)

    # ── slots ──────────────────────────────────────────────
    def _on_select(self):
        self._selector = RegionSelector()
        self._selector.region_selected.connect(self._on_region)
        self.hide()
        self._selector.show()

    def _on_region(self, rect: QRect):
        if not rect.isValid() or rect.isEmpty():
            self._lbl_region.setText("未选择区域")
            self._region = None
            self._btn_start.setEnabled(False)
        else:
            self._region = rect
            self._lbl_region.setText(
                f"区域: x={rect.x()}, y={rect.y()}, {rect.width()}×{rect.height()}"
            )
            self._btn_start.setEnabled(True)
        self.show()
        self.raise_()
        self.activateWindow()

    def _on_start(self):
        if self._region is None:
            return
        self._engine = CaptureEngine({
            'left': self._region.x(),
            'top': self._region.y(),
            'width': self._region.width(),
            'height': self._region.height(),
        })
        self._engine.start()
        self._timer.start(self._engine.interval_ms())
        self._btn_select.setEnabled(False)
        self._btn_start.setEnabled(False)
        self._btn_stop.setEnabled(True)
        self._btn_export.setEnabled(False)
        self._result_image = None
        self._preview.clear()
        self._status.showMessage("捕获中… 滚动页面以采集帧，按 Escape 或点击「停止并拼接」结束")

    def _on_tick(self):
        if self._engine is None or not self._engine.running:
            return
        added = self._engine.tick()
        if added:
            self._lbl_progress.setText(f"已采集 {self._engine.frame_count} 帧")

    def _on_stop(self):
        if self._engine:
            self._engine.stop()
        self._timer.stop()

        if self._engine is None or self._engine.frame_count == 0:
            self._status.showMessage("未采集到帧")
            self._btn_select.setEnabled(True)
            self._btn_start.setEnabled(self._region is not None)
            self._btn_stop.setEnabled(False)
            return

        self._status.showMessage(f"正在拼接 {self._engine.frame_count} 帧…")
        QApplication.processEvents()

        frames = self._engine.frames
        self._result_image = self._stitcher.stitch(frames)

        if self._result_image is None:
            QMessageBox.warning(self, "拼接失败", "无法拼接帧，请重试")
            self._btn_select.setEnabled(True)
            self._btn_start.setEnabled(self._region is not None)
            self._btn_stop.setEnabled(False)
            return

        # Show warnings
        if self._stitcher.warnings:
            self._status.showMessage(
                f"拼接完成 ({self._result_image.shape[1]}×{self._result_image.shape[0]}) — "
                + "; ".join(self._stitcher.warnings[:3])
            )
        else:
            self._status.showMessage(
                f"拼接完成 — {self._result_image.shape[1]}×{self._result_image.shape[0]}"
            )

        self._show_preview()
        self._btn_select.setEnabled(True)
        self._btn_start.setEnabled(self._region is not None)
        self._btn_stop.setEnabled(False)
        self._btn_export.setEnabled(True)

    def _show_preview(self):
        if self._result_image is None:
            return
        import numpy as np
        h, w = self._result_image.shape[:2]
        # Scale to fit width (max 650px) while keeping ratio
        target_w = min(w, 650)
        scale = target_w / w
        target_h = int(h * scale)
        # Convert BGR → RGB → QImage
        rgb = self._result_image[..., ::-1].copy()
        qimg = QImage(rgb.data, w, h, w * 3, QImage.Format_RGB888)
        pix = QPixmap.fromImage(qimg).scaled(
            target_w, target_h, Qt.KeepAspectRatio, Qt.SmoothTransformation
        )
        self._preview.setPixmap(pix)
        self._preview.setFixedSize(target_w, target_h)

    def _on_export(self):
        if self._result_image is None:
            return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_name = f"longshot_{ts}.png"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出长截图", default_name, "PNG (*.png)"
        )
        if not path:
            return
        import cv2
        cv2.imwrite(path, self._result_image)
        self._status.showMessage(f"已导出: {os.path.basename(path)}")


if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    # Dark theme
    app.setStyleSheet("""
    QMainWindow, QWidget { background: #1a1a2e; color: #ddd; font-family: 'Microsoft YaHei', sans-serif; font-size: 13px; }
    QPushButton { background: #2d2d44; border: 1px solid #444; border-radius: 6px; padding: 7px 16px; color: #ddd; }
    QPushButton:hover { background: #3d3d54; }
    QPushButton:disabled { background: #222; color: #666; border-color: #333; }
    QStatusBar { background: #111; color: #888; }
    """)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())
