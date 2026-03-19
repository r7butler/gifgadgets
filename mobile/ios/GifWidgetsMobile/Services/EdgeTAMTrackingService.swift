import Foundation
import CoreML
import UIKit

struct TrackingProgress: Sendable {
    let completedFrames: Int
    let totalFrames: Int
    let message: String
}

actor EdgeTAMTrackingService {
    struct LoadedModels {
        let imageEncoder: MLModel
        let promptEncoder: MLModel
        let maskDecoder: MLModel
        let imagePE: MLMultiArray
    }

    private var cachedModels: LoadedModels?

    func track(
        frames: [EditorFrame],
        sampledFrameIndices: [Int],
        clickFrameIndex: Int,
        normalizedPoint: CGPoint,
        progress: @Sendable @escaping (TrackingProgress) -> Void
    ) async throws -> [MotionKeyframe] {
        let models = try loadModelsIfNeeded()
        let sampled = sampledFrameIndices.sorted()
        guard !sampled.isEmpty else {
            throw EditorError.message("There are no frames available for tracking.")
        }
        guard let clickSampleIndex = sampled.firstIndex(of: clickFrameIndex) else {
            throw EditorError.message("The tapped frame is not part of the tracking sample set.")
        }

        var motionByFrame: [Int: MotionKeyframe] = [:]
        let totalWork = sampled.count + max(sampled.count - 1, 0)
        var completed = 0

        let startPoint = CGPoint(x: normalizedPoint.x * 1024, y: normalizedPoint.y * 1024)

        let forwardFrames = Array(sampled[clickSampleIndex...])
        var currentPoint = startPoint
        for frameIndex in forwardFrames {
            try Task.checkCancellation()
            progress(TrackingProgress(
                completedFrames: completed,
                totalFrames: totalWork,
                message: "EdgeTAM tracking frame \(completed + 1) of \(totalWork)…"
            ))
            let centroid = try predictCentroid(
                for: frames[frameIndex],
                point1024: currentPoint,
                models: models
            )
            currentPoint = centroid
            motionByFrame[frameIndex] = MotionKeyframe(
                frameIndex: frameIndex,
                x: (centroid.x / 1024).clamped(to: 0...1),
                y: (centroid.y / 1024).clamped(to: 0...1)
            )
            completed += 1
        }

        if clickSampleIndex > 0 {
            currentPoint = startPoint
            for frameIndex in sampled[..<clickSampleIndex].reversed() {
                try Task.checkCancellation()
                progress(TrackingProgress(
                    completedFrames: completed,
                    totalFrames: totalWork,
                    message: "EdgeTAM tracking frame \(completed + 1) of \(totalWork)…"
                ))
                let centroid = try predictCentroid(
                    for: frames[frameIndex],
                    point1024: currentPoint,
                    models: models
                )
                currentPoint = centroid
                motionByFrame[frameIndex] = MotionKeyframe(
                    frameIndex: frameIndex,
                    x: (centroid.x / 1024).clamped(to: 0...1),
                    y: (centroid.y / 1024).clamped(to: 0...1)
                )
                completed += 1
            }
        }

        return motionByFrame.values.sorted(by: { $0.frameIndex < $1.frameIndex })
    }

    private func loadModelsIfNeeded() throws -> LoadedModels {
        if let cachedModels {
            return cachedModels
        }

        guard
            let imageEncoderURL = locateResource(named: "edgetam_image_encoder", extension: "mlpackage"),
            let promptEncoderURL = locateResource(named: "edgetam_prompt_encoder", extension: "mlpackage"),
            let maskDecoderURL = locateResource(named: "edgetam_mask_decoder", extension: "mlpackage"),
            let imagePEURL = locateResource(named: "edgetam_image_pe", extension: "npy")
        else {
            throw EditorError.message(
                """
                EdgeTAM models were not found.

                Export the non-quantized CoreML assets into mobile/ios/GifWidgetsMobile/Resources/EdgeTAM and rebuild the app.
                """
            )
        }

        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all

        let (shape, values) = try loadNPYFloat32(url: imagePEURL)
        let models = LoadedModels(
            imageEncoder: try MLModel(contentsOf: imageEncoderURL, configuration: configuration),
            promptEncoder: try MLModel(contentsOf: promptEncoderURL, configuration: configuration),
            maskDecoder: try MLModel(contentsOf: maskDecoderURL, configuration: configuration),
            imagePE: try makeMultiArray(shape: shape, values: values)
        )
        cachedModels = models
        return models
    }

    private func locateResource(named name: String, extension ext: String) -> URL? {
        if let bundleURL = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "EdgeTAM") {
            return bundleURL
        }

        let fileManager = FileManager.default
        if let appSupport = try? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) {
            let url = appSupport.appendingPathComponent("EdgeTAM/\(name).\(ext)")
            if fileManager.fileExists(atPath: url.path) {
                return url
            }
        }

        return nil
    }

    private func predictCentroid(
        for frame: EditorFrame,
        point1024: CGPoint,
        models: LoadedModels
    ) throws -> CGPoint {
        let pixelBuffer = try frame.image.makePixelBuffer(width: 1024, height: 1024)
        let imageFeatures = try MLDictionaryFeatureProvider(dictionary: [
            "image": MLFeatureValue(pixelBuffer: pixelBuffer),
        ])
        let encoded = try models.imageEncoder.prediction(from: imageFeatures)

        guard
            let visionFeatures = encoded.featureValue(for: "vision_features")?.multiArrayValue,
            let highRes0 = encoded.featureValue(for: "high_res_feat_0")?.multiArrayValue,
            let highRes1 = encoded.featureValue(for: "high_res_feat_1")?.multiArrayValue
        else {
            throw EditorError.message("EdgeTAM image encoder returned unexpected outputs.")
        }

        let pointCoords = try makeMultiArray(shape: [1, 4, 2], values: Array(repeating: 0, count: 8))
        let pointLabels = try makeMultiArray(shape: [1, 4], values: [-1, -1, -1, -1])
        let boxes = try makeMultiArray(shape: [1, 4], values: Array(repeating: 0, count: 4))
        let maskInput = try makeMultiArray(shape: [1, 1, 256, 256], values: Array(repeating: 0, count: 256 * 256))

        pointCoords[0] = NSNumber(value: Float(point1024.x))
        pointCoords[1] = NSNumber(value: Float(point1024.y))
        pointLabels[0] = NSNumber(value: Float(1))

        let promptFeatures = try MLDictionaryFeatureProvider(dictionary: [
            "point_coords": MLFeatureValue(multiArray: pointCoords),
            "point_labels": MLFeatureValue(multiArray: pointLabels),
            "boxes": MLFeatureValue(multiArray: boxes),
            "mask_input": MLFeatureValue(multiArray: maskInput),
        ])
        let prompted = try models.promptEncoder.prediction(from: promptFeatures)

        guard
            let sparseEmbeddings = prompted.featureValue(for: "sparse_embeddings")?.multiArrayValue,
            let denseEmbeddings = prompted.featureValue(for: "dense_embeddings")?.multiArrayValue
        else {
            throw EditorError.message("EdgeTAM prompt encoder returned unexpected outputs.")
        }

        let multimask = try makeMultiArray(shape: [1], values: [0])
        let decoderFeatures = try MLDictionaryFeatureProvider(dictionary: [
            "image_embeddings": MLFeatureValue(multiArray: visionFeatures),
            "image_pe": MLFeatureValue(multiArray: models.imagePE),
            "sparse_prompt_embeddings": MLFeatureValue(multiArray: sparseEmbeddings),
            "dense_prompt_embeddings": MLFeatureValue(multiArray: denseEmbeddings),
            "high_res_feat_0": MLFeatureValue(multiArray: highRes0),
            "high_res_feat_1": MLFeatureValue(multiArray: highRes1),
            "multimask_output": MLFeatureValue(multiArray: multimask),
        ])
        let decoded = try models.maskDecoder.prediction(from: decoderFeatures)

        guard let masks = decoded.featureValue(for: "masks")?.multiArrayValue else {
            throw EditorError.message("EdgeTAM mask decoder returned no masks.")
        }

        if let centroid = centroidFromMask(masks) {
            return centroid
        }
        return point1024
    }

    private func centroidFromMask(_ mask: MLMultiArray) -> CGPoint? {
        let shape = mask.shape.map(\.intValue)
        guard shape.count >= 2 else { return nil }
        let width = shape[shape.count - 1]
        let height = shape[shape.count - 2]
        let pointer = mask.dataPointer.bindMemory(to: Float32.self, capacity: mask.count)

        var sumX: Double = 0
        var sumY: Double = 0
        var hits: Double = 0

        for y in 0..<height {
            for x in 0..<width {
                let value = pointer[(y * width) + x]
                if value > 0 {
                    sumX += Double(x)
                    sumY += Double(y)
                    hits += 1
                }
            }
        }

        guard hits > 0 else { return nil }
        let centroidX = CGFloat(sumX / hits) / CGFloat(width) * 1024
        let centroidY = CGFloat(sumY / hits) / CGFloat(height) * 1024
        return CGPoint(x: centroidX, y: centroidY)
    }

    private func loadNPYFloat32(url: URL) throws -> ([Int], [Float]) {
        let data = try Data(contentsOf: url)
        let magic: [UInt8] = [0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59]
        guard Array(data.prefix(6)) == magic else {
            throw EditorError.message("EdgeTAM positional encoding is not a valid .npy file.")
        }

        let major = data[data.startIndex.advanced(by: 6)]
        let headerStart: Int
        let headerLength: Int
        if major == 1 {
            headerStart = 10
            let lower = Int(data[data.startIndex.advanced(by: 8)])
            let upper = Int(data[data.startIndex.advanced(by: 9)]) << 8
            headerLength = lower | upper
        } else {
            headerStart = 12
            let b0 = Int(data[data.startIndex.advanced(by: 8)])
            let b1 = Int(data[data.startIndex.advanced(by: 9)]) << 8
            let b2 = Int(data[data.startIndex.advanced(by: 10)]) << 16
            let b3 = Int(data[data.startIndex.advanced(by: 11)]) << 24
            headerLength = b0 | b1 | b2 | b3
        }

        let headerRange = headerStart..<(headerStart + headerLength)
        guard
            headerRange.upperBound <= data.count,
            let header = String(data: data.subdata(in: headerRange), encoding: .ascii)
        else {
            throw EditorError.message("EdgeTAM positional encoding header could not be read.")
        }

        guard header.contains("<f4"), !header.contains("True") else {
            throw EditorError.message("EdgeTAM positional encoding must be little-endian float32 without Fortran order.")
        }

        guard
            let shapeStart = header.firstIndex(of: "("),
            let shapeEnd = header[shapeStart...].firstIndex(of: ")")
        else {
            throw EditorError.message("EdgeTAM positional encoding shape could not be parsed.")
        }

        let shapeContent = header[header.index(after: shapeStart)..<shapeEnd]
        let shape = shapeContent
            .split(separator: ",")
            .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        let expectedCount = shape.reduce(1, *)
        let bodyStart = headerRange.upperBound
        let bodyLength = expectedCount * MemoryLayout<Float32>.size
        guard bodyStart + bodyLength <= data.count else {
            throw EditorError.message("EdgeTAM positional encoding body is shorter than expected.")
        }

        var values = Array(repeating: Float(0), count: expectedCount)
        _ = values.withUnsafeMutableBytes { buffer in
            data.subdata(in: bodyStart..<(bodyStart + bodyLength)).copyBytes(to: buffer)
        }
        return (shape, values)
    }

    private func makeMultiArray(shape: [Int], values: [Float]) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: shape.map(NSNumber.init(value:)), dataType: .float32)
        let pointer = array.dataPointer.bindMemory(to: Float32.self, capacity: array.count)
        for index in 0..<array.count {
            pointer[index] = values[index]
        }
        return array
    }
}

private extension CGImage {
    func makePixelBuffer(width: Int, height: Int) throws -> CVPixelBuffer {
        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32ARGB,
            attributes as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw EditorError.message("A pixel buffer could not be created for EdgeTAM input.")
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard
            let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
            let context = CGContext(
                data: baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
            )
        else {
            throw EditorError.message("A drawing context could not be created for EdgeTAM input.")
        }

        context.interpolationQuality = .high
        context.draw(self, in: CGRect(x: 0, y: 0, width: width, height: height))
        return pixelBuffer
    }
}
