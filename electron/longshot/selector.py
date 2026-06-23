"""Fullscreen semi-transparent overlay for selecting a capture region."""
from PySide6.QtWidgets import QWidget, QApplication
from PySide6.QtCore import Qt, QRect, Signal, QPoint
from PySide6.QtGui import QPainter, QColor, QPen, QBrush


class RegionSelector(QWidget):
    """Fullscreen overlay that lets the user drag to select a rectangular region."""

    region_selected = Signal(QRect)

    def __init__(self):
        super().__init__()
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground, False)
        self.setStyleSheet("background: transparent;")
        # Cover all screens
        screen_geo = QApplication.primaryScreen().virtualGeometry()
        self.setGeometry(screen_geo)
        self._start = QPoint()
        self._end = QPoint()
        self._drawing = False
        self._confirmed = QRect()
        self.showFullScreen()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, False)
        # Dim everything
        p.fillRect(self.rect(), QColor(0, 0, 0, 120))

        if self._drawing and not self._start.isNull():
            r = QRect(self._start, self._end).normalized()
            # Punch hole — draw bright area
            p.setCompositionMode(QPainter.CompositionMode_Clear)
            p.fillRect(r, Qt.transparent)
            p.setCompositionMode(QPainter.CompositionMode_SourceOver)
            # Dashed border
            pen = QPen(QColor(255, 255, 255), 2, Qt.DashLine)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            p.drawRect(r)
        elif not self._confirmed.isNull():
            # Show confirmed selection
            r = self._confirmed
            p.setCompositionMode(QPainter.CompositionMode_Clear)
            p.fillRect(r, Qt.transparent)
            p.setCompositionMode(QPainter.CompositionMode_SourceOver)
            pen = QPen(QColor(0, 255, 136), 2, Qt.DashLine)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            p.drawRect(r)

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._drawing = True
            self._start = event.globalPosition().toPoint()
            self._end = self._start
            self._confirmed = QRect()
            self.update()

    def mouseMoveEvent(self, event):
        if self._drawing:
            self._end = event.globalPosition().toPoint()
            self.update()

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.LeftButton and self._drawing:
            self._drawing = False
            r = QRect(self._start, self._end).normalized()
            if r.width() >= 20 and r.height() >= 20:
                self._confirmed = r
                self.region_selected.emit(r)
            else:
                self._confirmed = QRect()
            self.update()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_Escape:
            self._confirmed = QRect()
            self.region_selected.emit(QRect())
            self.close()
