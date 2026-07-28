/**
 * 테스트 공통 준비. 소유: A
 *
 * @testing-library/jest-dom의 matcher(toBeInTheDocument 등)를 붙인다.
 * node 환경 파일에서도 import되지만 matcher를 등록만 할 뿐이라 문제되지 않는다.
 */
import '@testing-library/jest-dom/vitest';
