import CryptoKit
import Foundation

actor WebsiteShareService {
    private struct PresignRequest: Encodable {
        let title: String
        let filename: String?
        let contentType: String

        enum CodingKeys: String, CodingKey {
            case title
            case filename
            case contentType = "content_type"
        }
    }

    private struct PresignResponse: Decodable {
        let uploadURL: URL
        let slug: String
        let title: String
        let contentType: String

        enum CodingKeys: String, CodingKey {
            case uploadURL = "upload_url"
            case slug
            case title
            case contentType = "content_type"
        }
    }

    private struct FinalizeRequest: Encodable {
        let slug: String
        let title: String
        let contentType: String

        enum CodingKeys: String, CodingKey {
            case slug
            case title
            case contentType = "content_type"
        }
    }

    private struct ShareResponse: Decodable {
        let slug: String
        let shareURL: URL
        let mediaURL: URL

        enum CodingKeys: String, CodingKey {
            case slug
            case shareURL = "share_url"
            case mediaURL = "gif_url"
        }
    }

    private struct APIErrorResponse: Decodable {
        let error: String
    }

    private let session: URLSession
    private let jsonEncoder = JSONEncoder()
    private let jsonDecoder = JSONDecoder()
    private let baseURL: URL

    init(session: URLSession = .shared, baseURL: URL? = nil) {
        self.session = session
        self.baseURL = baseURL ?? Self.resolvedBaseURL()
    }

    func shareGIF(fileURL: URL, title: String, filename: String) async throws -> WebsiteShareResult {
        let presign: PresignResponse = try await postJSON(
            path: "share/presign",
            body: PresignRequest(
                title: title,
                filename: filename,
                contentType: "image/gif"
            )
        )

        var uploadRequest = URLRequest(url: presign.uploadURL)
        uploadRequest.httpMethod = "PUT"
        uploadRequest.setValue("image/gif", forHTTPHeaderField: "Content-Type")

        let (_, uploadResponse) = try await session.upload(for: uploadRequest, fromFile: fileURL)
        try validate(response: uploadResponse)

        let finalized: ShareResponse = try await postJSON(
            path: "share/finalize",
            body: FinalizeRequest(
                slug: presign.slug,
                title: presign.title,
                contentType: presign.contentType
            )
        )

        return WebsiteShareResult(
            slug: finalized.slug,
            shareURL: finalized.shareURL,
            mediaURL: finalized.mediaURL
        )
    }

    private func postJSON<Response: Decodable, Body: Encodable>(
        path: String,
        body: Body
    ) async throws -> Response {
        let requestBody = try jsonEncoder.encode(body)
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.httpBody = requestBody
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sha256Hex(for: requestBody), forHTTPHeaderField: "x-amz-content-sha256")

        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)

        do {
            return try jsonDecoder.decode(Response.self, from: data)
        } catch {
            throw EditorError.message("GifWidgets returned an unreadable response.")
        }
    }

    private func endpoint(_ path: String) -> URL {
        baseURL.appendingPathComponent(path)
    }

    private func validate(response: URLResponse, data: Data? = nil) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw EditorError.message("GifWidgets did not return a valid HTTP response.")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if
                let data,
                let decoded = try? jsonDecoder.decode(APIErrorResponse.self, from: data),
                !decoded.error.isEmpty
            {
                throw EditorError.message(decoded.error)
            }

            throw EditorError.message("GifWidgets share failed with status \(httpResponse.statusCode).")
        }
    }

    private func sha256Hex(for data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func resolvedBaseURL() -> URL {
        if
            let configured = Bundle.main.object(forInfoDictionaryKey: "GifWidgetsAPIBaseURL") as? String,
            let url = URL(string: configured),
            !configured.isEmpty
        {
            return url
        }

        return URL(string: "https://gifwidgets.com/api")!
    }
}
